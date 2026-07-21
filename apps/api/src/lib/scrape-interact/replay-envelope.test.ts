import { describe, expect, it } from "vitest";

import {
  normalizeReplayEnvelope,
  resolveReplayEnvelope,
  type ReplayBrowserSettingsV1,
  type ReplayEnvelopeSource,
  type StoredReplayCheckpoint,
} from "./replay-envelope";

const allBrowserSettings: ReplayBrowserSettingsV1 = {
  headers: {
    Authorization: "Bearer retained-token",
    "User-Agent": "Replay Browser/1.0",
  },
  cookies: [
    {
      name: "session",
      value: "retained-cookie",
      domain: ".example.com",
      path: "/",
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  viewport: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  deviceName: "Pixel 7",
  userAgent: "Replay Browser/1.0",
  locale: "fr-CA",
  timezoneId: "America/Toronto",
  geolocation: { latitude: 45.5019, longitude: -73.5674, accuracy: 12 },
  location: { country: "ca", languages: ["fr-CA", "en-CA"] },
  proxy: {
    kind: "stealth",
    country: "ca",
    credentialRef: "proxy-credential:7",
  },
  skipTlsVerification: true,
  blockAds: false,
  lockdown: true,
};

function source(
  overrides: Partial<ReplayEnvelopeSource> = {},
): ReplayEnvelopeSource {
  return {
    url: "https://example.com/products?q=one",
    callerOrigin: "api",
    options: {},
    ...overrides,
  };
}

function checkpoint(
  overrides: Record<string, unknown> = {},
): StoredReplayCheckpoint {
  return {
    version: 1,
    statePath: "replay/owner/scrape/state.json",
    storageState: {
      cookies: [
        {
          name: "session",
          value: "checkpoint-secret",
          domain: ".example.com",
          path: "/",
          expires: 2_000_000_000,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "theme", value: "dark" }],
          indexedDB: [
            {
              name: "auth",
              version: 1,
              stores: [
                {
                  name: "tokens",
                  autoIncrement: false,
                  keyPath: "id",
                  records: [
                    {
                      value: { token: "idb-secret" },
                    },
                  ],
                  indexes: [
                    {
                      name: "by-user",
                      keyPath: "userId",
                      multiEntry: false,
                      unique: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    finalUrl: "https://example.com/products/42",
    fingerprint: {
      finalUrl: "https://example.com/products/42",
      titleSha256: "a".repeat(64),
      bodyTextSha256: "b".repeat(64),
    },
    checksum: "c".repeat(64),
    byteSize: 321,
    ...overrides,
  } as StoredReplayCheckpoint;
}

function firstCheckpointStore(storedCheckpoint: StoredReplayCheckpoint) {
  return storedCheckpoint.storageState.origins[0].indexedDB![0].stores[0];
}

describe("replay envelope normalization", () => {
  it("rewrites canonical URLs and retains exact trusted browser settings", () => {
    const result = normalizeReplayEnvelope(
      source({
        url: "https://docs.google.com/document/d/document-id/edit",
        callerOrigin: "sdk-node",
        options: {
          waitFor: 1500,
          profile: { name: "signed-in", saveChanges: false },
        },
        browserSettings: allBrowserSettings,
        profileGenerationId: "generation:11",
      }),
    );

    expect(result).toEqual({
      kind: "ok",
      envelope: {
        version: 1,
        navigationPolicyVersion: 1,
        canonicalTargetUrl:
          "https://docs.google.com/document/d/document-id/export?format=html",
        callerOrigin: "sdk-node",
        waitForMs: 1500,
        browserSettings: allBrowserSettings,
        profile: {
          name: "signed-in",
          saveChanges: false,
          generationId: "generation:11",
        },
        actions: [],
      },
    });
  });

  it("classifies every scrape action without changing its exact payload", () => {
    const actions = [
      { type: "wait", milliseconds: 250 },
      { type: "wait", selector: "#ready" },
      { type: "scroll", direction: "up", selector: "main" },
      { type: "screenshot", fullPage: true, quality: 80 },
      { type: "pdf", landscape: true, scale: 0.8, format: "A4" },
      { type: "scrape" },
      { type: "click", selector: "button", all: true },
      { type: "write", text: "hello" },
      { type: "press", key: "Enter" },
      { type: "executeJavascript", script: "return document.title" },
    ];

    const result = normalizeReplayEnvelope(source({ options: { actions } }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.envelope.actions).toEqual(
      actions.map((action, index) => ({
        index,
        effect: index < 6 ? "read_only" : "side_effecting",
        action,
      })),
    );
  });

  it("knows every current baseScrapeOptions key and ignores output-only keys", () => {
    const outputOnly = {
      formats: "ignored even when not a valid format collection",
      includeTags: 12,
      excludeTags: null,
      onlyMainContent: "ignored",
      onlyCleanContent: "ignored",
      timeout: "ignored",
      parsers: "ignored",
      removeBase64Images: "ignored",
      fastMode: "ignored",
      useMock: 9,
      maxAge: "ignored",
      minAge: "ignored",
      storeInCache: "ignored",
      redactPII: "ignored",
      __searchPreviewToken: 9,
      __experimental_omce: "ignored",
      __experimental_omceDomain: 9,
      __experimental_engpicker: "ignored",
      __forceFirePDF: "ignored",
    };
    const result = normalizeReplayEnvelope(
      source({
        options: {
          ...outputOnly,
          headers: { "X-Replay": "yes" },
          waitFor: 0,
          mobile: false,
          actions: [],
          location: { country: "us-generic", languages: ["en-US"] },
          skipTlsVerification: false,
          blockAds: true,
          proxy: "auto",
          lockdown: false,
          profile: { name: "reader", saveChanges: true },
        },
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.envelope.waitForMs).toBe(0);
    expect(result.envelope.browserSettings.headers).toEqual({
      "X-Replay": "yes",
    });
    expect(JSON.stringify(result.envelope)).not.toContain("ignored");
  });

  it.each([
    [{ futureOption: true }, ["futureOption"]],
    [{ headers: { valid: 1 } }, ["headers.valid"]],
    [{ waitFor: -1 }, ["waitFor"]],
    [{ mobile: "yes" }, ["mobile"]],
    [{ location: { country: 7 } }, ["location.country"]],
    [{ profile: { name: "", saveChanges: true } }, ["profile.name"]],
    [{ proxy: { kind: "basic", password: "secret" } }, ["proxy"]],
    [{ actions: [{ type: "click" }] }, ["actions.0.selector"]],
    [{ actions: [{ type: "futureAction" }] }, ["actions.0.type"]],
  ])("reports malformed or unknown option fields: %j", (options, fields) => {
    expect(normalizeReplayEnvelope(source({ options }))).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields,
    });
  });

  it("reports every malformed field rather than stopping at the first", () => {
    expect(
      normalizeReplayEnvelope(
        source({
          options: {
            waitFor: -1,
            headers: { authorization: 10 },
            location: { languages: ["en", 3] },
            unknown: true,
          },
        }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: [
        "headers.authorization",
        "location.languages.1",
        "unknown",
        "waitFor",
      ],
    });
  });

  it.each(["US", "ca", "us-generic", "US-WHITELIST"])(
    "accepts a current location country: %s",
    country => {
      const result = normalizeReplayEnvelope(
        source({ options: { location: { country } } }),
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.envelope.browserSettings.location.country).toBe(
        country.toLowerCase(),
      );
    },
  );

  it("aggregates independent fields when retained inputs are unavailable", () => {
    const secretUrl = "<redacted:proxy-password>";
    const result = resolveReplayEnvelope(
      source({
        url: secretUrl,
        options: null,
        callerOrigin: "",
        browserSettings: {
          ...allBrowserSettings,
          viewport: { ...allBrowserSettings.viewport, hasTouch: "yes" },
          proxy: { kind: "basic", username: "proxy-password" },
        },
        profileGenerationId: "",
        checkpoint: checkpoint({ checksum: "checkpoint-secret" }),
      }),
    );

    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
      fields: [
        "browserSettings.proxy.username",
        "browserSettings.viewport.hasTouch",
        "callerOrigin",
        "checkpoint.checksum",
        "options",
        "profile.generationId",
        "url",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("proxy-password");
    expect(JSON.stringify(result)).not.toContain("checkpoint-secret");
  });

  it("keeps unsupported precedence for present but malformed inputs", () => {
    expect(
      normalizeReplayEnvelope(
        source({
          url: "https://internal/path",
          options: { futureOption: true },
          callerOrigin: "",
          browserSettings: {
            ...allBrowserSettings,
            viewport: { ...allBrowserSettings.viewport, hasTouch: "yes" },
          },
          profileGenerationId: "",
        }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: [
        "browserSettings.viewport.hasTouch",
        "callerOrigin",
        "futureOption",
        "profile.generationId",
        "url",
      ],
    });
  });

  it("rejects a non-ISO location country", () => {
    expect(
      normalizeReplayEnvelope(
        source({ options: { location: { country: "canada" } } }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["location.country"],
    });
  });

  it("enforces the current aggregate scrape wait budget", () => {
    expect(
      normalizeReplayEnvelope(
        source({
          options: {
            waitFor: 30_000,
            actions: [{ type: "wait", milliseconds: 30_000 }],
          },
        }),
      ).kind,
    ).toBe("ok");
    expect(
      normalizeReplayEnvelope(
        source({
          options: {
            waitFor: 30_000,
            actions: [{ type: "wait", milliseconds: 30_001 }],
          },
        }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["actions", "waitFor"],
    });
    expect(
      normalizeReplayEnvelope(
        source({
          options: {
            waitFor: 59_001,
            actions: [{ type: "wait", selector: "#ready" }],
          },
        }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["actions", "waitFor"],
    });
  });

  it.each([
    [source({ url: "<redacted>" }), ["url"]],
    [source({ options: "<redacted>" }), ["options"]],
    [source({ url: null, options: null }), ["options", "url"]],
    [source({ zeroDataRetention: true }), ["options", "url"]],
  ])(
    "returns replay_unavailable for absent retained state",
    (input, fields) => {
      expect(normalizeReplayEnvelope(input)).toMatchObject({
        kind: "error",
        category: "replay_unavailable",
        fields,
      });
    },
  );

  it("rejects malformed trusted settings and names their exact paths", () => {
    const malformed = {
      ...allBrowserSettings,
      viewport: { ...allBrowserSettings.viewport, hasTouch: "yes" },
      proxy: { kind: "basic", username: "must-not-be-retained" },
    };
    expect(
      normalizeReplayEnvelope(source({ browserSettings: malformed })),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: [
        "browserSettings.proxy.username",
        "browserSettings.viewport.hasTouch",
      ],
    });
  });

  it("validates HTTP headers, locales, timezones, and proxy countries", () => {
    const result = normalizeReplayEnvelope(
      source({
        browserSettings: {
          ...allBrowserSettings,
          headers: {
            "bad header": "value",
            "X-Bad-Value": "line one\nline two",
          },
          locale: "en_US",
          timezoneId: "Mars/Olympus_Mons",
          location: { country: "ca", languages: ["fr-CA", "not_a_locale"] },
          proxy: {
            kind: "stealth",
            country: "canada",
            credentialRef: "proxy-credential:7",
          },
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: [
        "browserSettings.headers.bad header",
        "browserSettings.headers.X-Bad-Value",
        "browserSettings.locale",
        "browserSettings.location.languages.1",
        "browserSettings.proxy.country",
        "browserSettings.timezoneId",
      ],
    });
  });

  it("rejects invalid option header tokens and values by field", () => {
    expect(
      normalizeReplayEnvelope(
        source({
          options: {
            headers: {
              "bad header": "value",
              "X-Bad-Value": "one\ntwo",
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["headers.bad header", "headers.X-Bad-Value"],
    });
  });

  it("rejects credentials embedded in target URLs without echoing them", () => {
    const result = normalizeReplayEnvelope(
      source({ url: "https://proxy-user:proxy-password@example.com/private" }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["url"],
    });
    expect(JSON.stringify(result)).not.toContain("proxy-password");
  });

  it("accepts only opaque proxy credential references", () => {
    const result = normalizeReplayEnvelope(
      source({
        browserSettings: {
          ...allBrowserSettings,
          proxy: {
            kind: "basic",
            credentialRef: "https://proxy-user:proxy-password@proxy.local",
          },
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["browserSettings.proxy.credentialRef"],
    });
    expect(JSON.stringify(result)).not.toContain("proxy-password");
  });

  it("requires concrete credential refs and never echoes secret-shaped refs", () => {
    const secretRef = "proxy-credential:proxy-password";
    const result = normalizeReplayEnvelope(
      source({
        browserSettings: {
          ...allBrowserSettings,
          proxy: { kind: "basic", credentialRef: secretRef },
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["browserSettings.proxy.credentialRef"],
    });
    expect(JSON.stringify(result)).not.toContain(secretRef);
    expect(
      normalizeReplayEnvelope(
        source({
          browserSettings: {
            ...allBrowserSettings,
            proxy: {
              kind: "basic",
              credentialRef: "proxy-credential:opaque_7.1",
            },
          },
        }),
      ).kind,
    ).toBe("ok");
  });

  it.each([
    "http://localhost/path",
    "http://127.0.0.1/path",
    "https://internal/path",
  ])("rejects a non-public retained target host: %s", url => {
    expect(normalizeReplayEnvelope(source({ url }))).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["url"],
    });
  });
});

describe("replay resolution", () => {
  it("uses a checkpoint without returning actions for execution", () => {
    const result = resolveReplayEnvelope(
      source({
        options: {
          actions: [{ type: "click", selector: "#paid" }],
        },
        browserSettings: allBrowserSettings,
        checkpoint: checkpoint(),
      }),
    );

    expect(result.kind).toBe("checkpoint");
    if (result.kind !== "checkpoint") return;
    expect(result.checkpoint.finalUrl).toBe("https://example.com/products/42");
    expect(result.envelope.browserSettings).toEqual(allBrowserSettings);
    expect(result.envelope.actions).toHaveLength(1);
    expect("safeActions" in result).toBe(false);
  });

  it("allows every read-only legacy action", () => {
    const safeActions = [
      { type: "wait", milliseconds: 50 },
      { type: "scroll", direction: "down" },
      { type: "screenshot", fullPage: false },
      { type: "pdf", landscape: false, scale: 1, format: "Letter" },
      { type: "scrape" },
    ];
    expect(
      resolveReplayEnvelope(source({ options: { actions: safeActions } })),
    ).toMatchObject({ kind: "legacy", safeActions });
  });

  it("rejects every side-effecting legacy action by original index", () => {
    const result = resolveReplayEnvelope(
      source({
        options: {
          actions: [
            { type: "wait", milliseconds: 50 },
            { type: "click", selector: "button" },
            { type: "write", text: "value" },
            { type: "press", key: "Enter" },
            { type: "executeJavascript", script: "return 1" },
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["actions.1", "actions.2", "actions.3", "actions.4"],
    });
  });

  it("aggregates every unsafe or malformed legacy action index", () => {
    const result = resolveReplayEnvelope(
      source({
        options: {
          actions: [
            { type: "wait" },
            { type: "click" },
            { type: "write", text: "value" },
            { type: "futureAction" },
            { type: "scroll", direction: "sideways" },
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
    });
    if (result.kind !== "error") return;
    expect(result.fields).toEqual(
      expect.arrayContaining([
        "actions.0",
        "actions.1",
        "actions.2",
        "actions.3",
        "actions.4",
      ]),
    );
  });

  it("rejects a legacy profile without an immutable generation", () => {
    expect(
      resolveReplayEnvelope(
        source({
          options: { profile: { name: "signed-in", saveChanges: false } },
        }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["profile.generationId"],
    });
  });

  it("rejects a profile generation when no profile was retained", () => {
    expect(
      resolveReplayEnvelope(source({ profileGenerationId: "generation:12" })),
    ).toMatchObject({
      kind: "error",
      category: "replay_unsupported",
      fields: ["profile.generationId"],
    });
  });

  it("rejects malformed checkpoints without falling back to legacy replay", () => {
    expect(
      resolveReplayEnvelope(
        source({ checkpoint: checkpoint({ checksum: "not-a-checksum" }) }),
      ),
    ).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
      fields: ["checkpoint.checksum"],
    });
  });

  it("preserves detached and frozen Playwright CHIPS cookie metadata", () => {
    const storedCheckpoint = checkpoint();
    const chipsCookie = {
      ...storedCheckpoint.storageState.cookies[0],
      partitionKey: "https://top-level.example",
      _crHasCrossSiteAncestor: true,
    };
    storedCheckpoint.storageState.cookies = [chipsCookie];

    const result = resolveReplayEnvelope(
      source({ checkpoint: storedCheckpoint }),
    );
    expect(result.kind).toBe("checkpoint");
    if (result.kind !== "checkpoint") return;

    chipsCookie.partitionKey = "https://mutated.example";
    chipsCookie._crHasCrossSiteAncestor = false;

    expect(result.checkpoint.storageState.cookies[0]).toMatchObject({
      partitionKey: "https://top-level.example",
      _crHasCrossSiteAncestor: true,
    });
    expect(Object.isFrozen(result.checkpoint.storageState.cookies[0])).toBe(
      true,
    );
  });

  it("preserves valid inline and out-of-line IndexedDB record keys", () => {
    const storedCheckpoint = checkpoint();
    const store = firstCheckpointStore(storedCheckpoint);
    delete store.records[0].key;
    store.indexes = [
      {
        name: "by-user",
        keyPath: "userId",
        multiEntry: false,
        unique: true,
      },
      {
        name: "by-tenant-user",
        keyPathArray: ["tenantId", "userId"],
        multiEntry: false,
        unique: false,
      },
    ];
    const inlineArrayStore = {
      ...structuredClone(store),
      name: "inline-array",
      keyPath: undefined,
      keyPathArray: ["tenantId", "id"],
    };
    const outOfLineStore = {
      ...structuredClone(store),
      name: "out-of-line",
      keyPath: undefined,
      records: [
        { key: "plain-key", value: { token: "plain" } },
        {
          keyEncoded: { s: "encoded-key" },
          valueEncoded: { s: "encoded-value" },
        },
      ],
    };
    storedCheckpoint.storageState.origins[0].indexedDB![0].stores = [
      store,
      inlineArrayStore,
      outOfLineStore,
    ];

    const result = resolveReplayEnvelope(
      source({ checkpoint: storedCheckpoint }),
    );
    expect(result.kind).toBe("checkpoint");
    if (result.kind !== "checkpoint") return;

    inlineArrayStore.keyPathArray[0] = "mutated";
    outOfLineStore.records[0].key = "mutated";

    const resolvedStores =
      result.checkpoint.storageState.origins[0].indexedDB![0].stores;
    expect(resolvedStores[1].keyPathArray).toEqual(["tenantId", "id"]);
    expect(resolvedStores[2].records[0].key).toBe("plain-key");
    expect(Object.isFrozen(resolvedStores[1].keyPathArray)).toBe(true);
    expect(Object.isFrozen(resolvedStores[2].records[0])).toBe(true);
  });

  it.each([
    {
      name: "inline record key",
      configure: (store: ReturnType<typeof firstCheckpointStore>) => {
        store.keyPath = "id";
        store.records[0].key = "unexpected-key";
      },
      fields: [
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.records.0.key",
      ],
    },
    {
      name: "missing out-of-line record key",
      configure: (store: ReturnType<typeof firstCheckpointStore>) => {
        delete store.keyPath;
        delete store.records[0].key;
      },
      fields: [
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.records.0.key",
      ],
    },
    {
      name: "duplicate out-of-line record keys",
      configure: (store: ReturnType<typeof firstCheckpointStore>) => {
        delete store.keyPath;
        store.records[0].key = "plain-key";
        store.records[0].keyEncoded = { s: "encoded-key" };
      },
      fields: [
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.records.0.key",
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.records.0.keyEncoded",
      ],
    },
    {
      name: "ambiguous store key paths",
      configure: (store: ReturnType<typeof firstCheckpointStore>) => {
        store.keyPathArray = ["tenantId", "id"];
      },
      fields: [
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.keyPath",
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.keyPathArray",
      ],
    },
    {
      name: "missing index key path",
      configure: (store: ReturnType<typeof firstCheckpointStore>) => {
        delete store.indexes[0].keyPath;
      },
      fields: [
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.indexes.0.keyPath",
      ],
    },
    {
      name: "ambiguous index key paths",
      configure: (store: ReturnType<typeof firstCheckpointStore>) => {
        store.indexes[0].keyPathArray = ["tenantId", "userId"];
      },
      fields: [
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.indexes.0.keyPath",
        "checkpoint.storageState.origins.0.indexedDB.0.stores.0.indexes.0.keyPathArray",
      ],
    },
  ])("rejects $name", ({ configure, fields }) => {
    const storedCheckpoint = checkpoint();
    configure(firstCheckpointStore(storedCheckpoint));

    expect(
      resolveReplayEnvelope(source({ checkpoint: storedCheckpoint })),
    ).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
      fields,
    });
  });

  it.each([
    ["partitionKey", 7],
    ["_crHasCrossSiteAncestor", "yes"],
  ])("rejects malformed Playwright cookie field %s", (field, value) => {
    const storedCheckpoint = checkpoint();
    storedCheckpoint.storageState.cookies = [
      {
        ...storedCheckpoint.storageState.cookies[0],
        [field]: value,
      },
    ];

    expect(
      resolveReplayEnvelope(source({ checkpoint: storedCheckpoint })),
    ).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
      fields: [`checkpoint.storageState.cookies.0.${field}`],
    });
  });

  it.each([
    [
      {
        cookies: [
          {
            name: "session",
            value: "secret",
            domain: ".example.com",
            path: "/",
            expires: 2_000_000_000,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            futureCookieField: true,
          },
        ],
        origins: [],
      },
      "checkpoint.storageState.cookies.0.futureCookieField",
    ],
    [
      {
        cookies: [],
        origins: [
          {
            origin: "https://example.com",
            localStorage: [{ name: "token", value: 7 }],
          },
        ],
      },
      "checkpoint.storageState.origins.0.localStorage.0.value",
    ],
    [
      {
        cookies: [],
        origins: [
          {
            origin: "https://example.com",
            localStorage: [],
            indexedDB: [{ name: "auth", version: 1, stores: "not-an-array" }],
          },
        ],
      },
      "checkpoint.storageState.origins.0.indexedDB.0.stores",
    ],
  ])(
    "rejects malformed Playwright storage state at %s",
    (storageState, field) => {
      expect(
        resolveReplayEnvelope(
          source({ checkpoint: checkpoint({ storageState }) }),
        ),
      ).toMatchObject({
        kind: "error",
        category: "replay_unavailable",
        fields: [field],
      });
    },
  );

  it("collects checkpoint errors with malformed source fields", () => {
    const result = resolveReplayEnvelope(
      source({
        callerOrigin: "",
        options: { futureOption: true },
        checkpoint: checkpoint({ checksum: "bad" }),
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
      fields: ["callerOrigin", "checkpoint.checksum", "futureOption"],
    });
  });

  it.each(["http://localhost/final", "https://internal/final"])(
    "rejects a checkpoint with a non-public host: %s",
    finalUrl => {
      expect(
        resolveReplayEnvelope(
          source({
            checkpoint: checkpoint({
              finalUrl,
              fingerprint: {
                finalUrl,
                titleSha256: "a".repeat(64),
                bodyTextSha256: "b".repeat(64),
              },
            }),
          }),
        ),
      ).toMatchObject({
        kind: "error",
        category: "replay_unavailable",
        fields: ["checkpoint.finalUrl", "checkpoint.fingerprint.finalUrl"],
      });
    },
  );

  it("detaches and deep-freezes every returned replay DTO branch", () => {
    const browserSettings = structuredClone(allBrowserSettings);
    const storedCheckpoint = checkpoint();
    const input = source({
      options: { actions: [{ type: "wait", selector: "#ready" }] },
      browserSettings,
      checkpoint: storedCheckpoint,
    });
    const resolved = resolveReplayEnvelope(input);
    expect(resolved.kind).toBe("checkpoint");
    if (resolved.kind !== "checkpoint") return;

    browserSettings.headers.Authorization = "mutated";
    storedCheckpoint.storageState.cookies[0].value = "mutated";
    storedCheckpoint.storageState.origins[0].localStorage[0].value = "mutated";

    expect(resolved.envelope.browserSettings.headers.Authorization).toBe(
      "Bearer retained-token",
    );
    expect(resolved.checkpoint.storageState.cookies[0].value).toBe(
      "checkpoint-secret",
    );
    expect(
      resolved.checkpoint.storageState.origins[0].localStorage[0].value,
    ).toBe("dark");

    const assertDeepFrozen = (value: unknown, seen = new WeakSet<object>()) => {
      if (value === null || typeof value !== "object" || seen.has(value))
        return;
      seen.add(value);
      expect(Object.isFrozen(value)).toBe(true);
      for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
    };
    assertDeepFrozen(resolved);
    assertDeepFrozen(
      resolveReplayEnvelope(
        source({ options: { actions: [{ type: "wait", milliseconds: 1 }] } }),
      ),
    );
    assertDeepFrozen(normalizeReplayEnvelope(source()));
    assertDeepFrozen(
      normalizeReplayEnvelope(source({ options: { futureOption: true } })),
    );
  });

  it("rejects checkpoint URL credentials without echoing them", () => {
    const credentialUrl =
      "https://proxy-user:proxy-password@example.com/products/42";
    const result = resolveReplayEnvelope(
      source({
        checkpoint: checkpoint({
          finalUrl: credentialUrl,
          fingerprint: {
            finalUrl: credentialUrl,
            titleSha256: "a".repeat(64),
            bodyTextSha256: "b".repeat(64),
          },
        }),
      }),
    );
    expect(result).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
      fields: ["checkpoint.finalUrl", "checkpoint.fingerprint.finalUrl"],
    });
    expect(JSON.stringify(result)).not.toContain("proxy-password");
  });

  it("retains only a server-side proxy credential reference", () => {
    const result = resolveReplayEnvelope(
      source({ browserSettings: allBrowserSettings, checkpoint: checkpoint() }),
    );
    expect(result.kind).toBe("checkpoint");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("proxy-credential:7");
    expect(serialized).not.toContain("proxy-password");
    expect(serialized).not.toContain("proxy-username");
  });
});
