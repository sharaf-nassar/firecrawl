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
  overrides: Partial<StoredReplayCheckpoint> = {},
): StoredReplayCheckpoint {
  return {
    version: 1,
    statePath: "replay/owner/scrape/state.json",
    storageState: {
      cookies: [{ name: "session", value: "checkpoint-secret" }],
      origins: [{ origin: "https://example.com", localStorage: [] }],
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
  };
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
