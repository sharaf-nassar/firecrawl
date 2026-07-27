import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { chromium } from "playwright";

import { canonicalJson, type StorageStateV1 } from "./contracts.js";
import { createEgressProxy, createRestoreGate } from "./egress-proxy.js";
import { createProfileStore } from "./profile-store.js";
import {
  canonicalizeReconciliationSnapshot,
  closeAnchoredProfileRoot,
  consumeInternalReconciliationOutcome,
  launchPersistentChromiumForWorking,
  reconcileBrowserStateWithAuthority,
  type AnchoredProfileRoot,
} from "./reconciliation.js";
import {
  loadReplayCheckpointFromBytes,
  semanticNormalizeStorageState,
  verifySemanticallyEquivalentStorageState,
} from "./replay-restore.js";
import { createSessionRegistry } from "./session-registry.js";

const roots: string[] = [];
const CHECKPOINT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_V7 = "019fa263-7912-7438-9837-60c547ecb22a";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const EMPTY_STATE: StorageStateV1 = { cookies: [], origins: [] };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointHarness(state: StorageStateV1 = EMPTY_STATE) {
  const statePath = `replay/owner/scrape/${CHECKPOINT_ID}.json`;
  const bytes = Buffer.from(canonicalJson(state));
  return {
    bytes,
    checkpoint: {
      checkpointId: CHECKPOINT_ID,
      statePath,
      checksum: sha256(bytes),
      byteSize: bytes.length,
      storageState: state,
      finalUrl: "https://example.com/",
      fingerprint: {
        finalUrl: "https://example.com/",
        titleSha256: "b".repeat(64),
        bodyTextSha256: "c".repeat(64),
      },
    },
  };
}

describe("replay capability payload", () => {
  test("accepts exact canonical storage bytes under exact replay grammar", () => {
    const { bytes, checkpoint } = checkpointHarness();
    const loaded = loadReplayCheckpointFromBytes(checkpoint, bytes);
    expect(loaded.rawBytes).toEqual(Buffer.from(canonicalJson(EMPTY_STATE)));
    expect(loaded.storageState).toEqual(EMPTY_STATE);
  });

  test("checkpoint payload is canonical storage bytes, not an envelope", () => {
    const { checkpoint } = checkpointHarness();
    const envelope = Buffer.from(canonicalJson(checkpoint));
    expect(() =>
      loadReplayCheckpointFromBytes(
        {
          ...checkpoint,
          byteSize: envelope.length,
          checksum: sha256(envelope),
        },
        envelope,
      ),
    ).toThrow(expect.objectContaining({ category: "replay_unavailable" }));
  });

  test("rejects whitespace, metadata mismatch, and request/payload mismatch", () => {
    const { bytes, checkpoint } = checkpointHarness();
    for (const candidate of [
      { ...checkpoint, byteSize: checkpoint.byteSize + 1 },
      { ...checkpoint, checksum: "d".repeat(64) },
      {
        ...checkpoint,
        storageState: {
          cookies: [],
          origins: [{ origin: "https://x.test/", localStorage: [] }],
        },
      },
    ]) {
      expect(() =>
        loadReplayCheckpointFromBytes(candidate, bytes),
      ).toThrow(expect.objectContaining({ category: "replay_unavailable" }));
    }
    const spaced = Buffer.from(` ${canonicalJson(EMPTY_STATE)}`);
    expect(() =>
      loadReplayCheckpointFromBytes(
        {
          ...checkpoint,
          byteSize: spaced.length,
          checksum: sha256(spaced),
        },
        spaced,
      ),
    ).toThrow(expect.objectContaining({ category: "replay_unavailable" }));
  });

  test("rejects inserted namespaces, doubled replay, and traversal", () => {
    const { bytes, checkpoint } = checkpointHarness();
    for (const statePath of [
      `state/replay/owner/scrape/${CHECKPOINT_ID}.json`,
      `replay/replay/owner/${CHECKPOINT_ID}.json`,
      `replay/owner/../scrape/${CHECKPOINT_ID}.json`,
    ]) {
      expect(() =>
        loadReplayCheckpointFromBytes(
          { ...checkpoint, statePath },
          bytes,
        ),
      ).toThrow(expect.objectContaining({ category: "replay_unavailable" }));
    }
  });
});

describe("semantic replay comparison", () => {
  test("normalizes empty origins and absent IndexedDB as empty", () => {
    expect(
      verifySemanticallyEquivalentStorageState(
        {
          cookies: [],
          origins: [{ origin: "https://empty.test/", localStorage: [] }],
        },
        EMPTY_STATE,
      ),
    ).toBeUndefined();
  });

  test("normalizes nested semantic sets by tagged UTF-8 byte order", () => {
    const records = [
      { key: "z", value: { x: 1 } },
      { key: "a", value: { x: 2 } },
    ];
    const state = {
      cookies: [],
      origins: [
        {
          origin: "https://db.test/",
          localStorage: [
            { name: "é", value: "1" },
            { name: "z", value: "2" },
          ],
          indexedDB: [
            {
              name: "db",
              version: 1,
              stores: [
                {
                  name: "store",
                  autoIncrement: false,
                  records,
                  indexes: [],
                },
              ],
            },
          ],
        },
      ],
    } satisfies StorageStateV1;
    const reversed = structuredClone(state);
    reversed.origins[0]!.localStorage.reverse();
    reversed.origins[0]!.indexedDB![0]!.stores[0]!.records.reverse();
    expect(semanticNormalizeStorageState(reversed)).toEqual(
      semanticNormalizeStorageState(state),
    );
  });

  test("normalizes every semantic set but preserves ordered value arrays", () => {
    const cookie = (name: string, value: string) => ({
      name,
      value,
      domain: "example.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax" as const,
    });
    const state = {
      cookies: [cookie("é", "one"), cookie("z", "two")],
      origins: [
        {
          origin: "https://z.test/",
          localStorage: [{ name: "kept", value: "z" }],
        },
        {
          origin: "https://db.test/",
          localStorage: [
            { name: "é", value: "one" },
            { name: "z", value: "two" },
          ],
          indexedDB: [
            { name: "z-db", version: 1, stores: [] },
            {
              name: "a-db",
              version: 1,
              stores: [
                {
                  name: "z-store",
                  autoIncrement: false,
                  records: [
                    { key: "é", value: ["first", "second"] },
                    { keyEncoded: "z", valueEncoded: { encoded: true } },
                  ],
                  indexes: [
                    {
                      name: "z-index",
                      keyPath: "id",
                      multiEntry: false,
                      unique: false,
                    },
                    {
                      name: "a-index",
                      keyPathArray: ["first", "second"],
                      multiEntry: false,
                      unique: true,
                    },
                  ],
                },
                {
                  name: "a-store",
                  autoIncrement: false,
                  keyPathArray: ["tenant", "id"],
                  records: [
                    { value: { id: "z", tenant: "one" } },
                    { value: { id: "a", tenant: "one" } },
                  ],
                  indexes: [],
                },
              ],
            },
          ],
        },
      ],
    } satisfies StorageStateV1;
    const reversed = structuredClone(state);
    reversed.cookies.reverse();
    reversed.origins.reverse();
    const origin = reversed.origins.find(
      (candidate) => candidate.origin === "https://db.test/",
    )!;
    origin.localStorage.reverse();
    origin.indexedDB!.reverse();
    const database = origin.indexedDB!.find(
      (candidate) => candidate.name === "a-db",
    )!;
    database.stores.reverse();
    const outOfLine = database.stores.find(
      (candidate) => candidate.name === "z-store",
    )!;
    outOfLine.records.reverse();
    outOfLine.indexes.reverse();
    const inline = database.stores.find(
      (candidate) => candidate.name === "a-store",
    )!;
    inline.records.reverse();

    expect(semanticNormalizeStorageState(reversed)).toEqual(
      semanticNormalizeStorageState(state),
    );

    const changed = structuredClone(state);
    changed.origins[1]!.indexedDB![1]!.stores[1]!.keyPathArray!.reverse();
    expect(semanticNormalizeStorageState(changed)).not.toEqual(
      semanticNormalizeStorageState(state),
    );
  });

  test("rejects every duplicate semantic identity", () => {
    const cookie = {
      name: "sid",
      value: "1",
      domain: "example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    };
    expect(() =>
      semanticNormalizeStorageState({
        cookies: [cookie, { ...cookie, value: "2" }],
        origins: [],
      }),
    ).toThrowError(/duplicate/u);

    const local = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com/",
          localStorage: [
            { name: "x", value: "1" },
            { name: "x", value: "2" },
          ],
        },
      ],
    };
    expect(() => semanticNormalizeStorageState(local)).toThrowError(
      /duplicate/u,
    );
    expect(() =>
      semanticNormalizeStorageState({
        cookies: [],
        origins: [
          { origin: "https://empty.test/", localStorage: [] },
          { origin: "https://empty.test/", localStorage: [], indexedDB: [] },
        ],
      }),
    ).toThrowError(/duplicate/u);

    const nested = {
      cookies: [],
      origins: [
        {
          origin: "https://db.test/",
          localStorage: [],
          indexedDB: [
            {
              name: "db",
              version: 1,
              stores: [
                {
                  name: "store",
                  autoIncrement: false,
                  records: [{ key: "id", value: 1 }],
                  indexes: [
                    {
                      name: "index",
                      keyPath: "id",
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
    } satisfies StorageStateV1;
    const duplicateDatabase = structuredClone(nested);
    duplicateDatabase.origins[0]!.indexedDB!.push({
      name: "db",
      version: 2,
      stores: [],
    });
    const duplicateStore = structuredClone(nested);
    duplicateStore.origins[0]!.indexedDB![0]!.stores.push({
      name: "store",
      autoIncrement: true,
      records: [],
      indexes: [],
    });
    const duplicateRecord = structuredClone(nested);
    duplicateRecord.origins[0]!.indexedDB![0]!.stores[0]!.records.push({
      key: "id",
      value: 2,
    });
    const duplicateIndex = structuredClone(nested);
    duplicateIndex.origins[0]!.indexedDB![0]!.stores[0]!.indexes.push({
      name: "index",
      keyPath: "other",
      multiEntry: false,
      unique: true,
    });
    for (const fixture of [
      duplicateDatabase,
      duplicateStore,
      duplicateRecord,
      duplicateIndex,
    ]) {
      expect(() => semanticNormalizeStorageState(fixture)).toThrowError(
        /duplicate/u,
      );
    }
  });

  test("tagged key and keyEncoded records cannot collide", () => {
    const make = (record: Record<string, unknown>) => ({
      cookies: [],
      origins: [
        {
          origin: "https://db.test/",
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
                  indexes: [],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      semanticNormalizeStorageState(make({ key: "x", value: 1 })),
    ).not.toEqual(
      semanticNormalizeStorageState(make({ keyEncoded: "x", value: 1 })),
    );
  });
});

describe("real Playwright 1.61.1 restore", () => {
  test("restores cookies, localStorage, and IndexedDB behind a closed ingress gate", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "replay-chromium-"));
    roots.push(userDataDir);
    const gate = createRestoreGate();
    const proxy = await createEgressProxy({ restoreGate: gate });
    const state: StorageStateV1 = {
      cookies: [
        {
          name: "sid",
          value: "cookie",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://example.com/",
          localStorage: [{ name: "local", value: "storage" }],
          indexedDB: [
            {
              name: "task4-db",
              version: 1,
              stores: [
                {
                  name: "records",
                  autoIncrement: false,
                  records: [{ key: "id", value: { restored: true } }],
                  indexes: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const launchOptions = {
      headless: true,
      acceptDownloads: false,
      serviceWorkers: "block" as const,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: [
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    };
    expect(launchOptions).not.toHaveProperty("storageState");
    const context = await chromium.launchPersistentContext(
      userDataDir,
      launchOptions,
    );
    try {
      await context.setStorageState(state);
      const exported: unknown = await context.storageState({ indexedDB: true });
      verifySemanticallyEquivalentStorageState(exported, state);
      expect(exported).toMatchObject({
        cookies: [{ name: "sid", value: "cookie" }],
        origins: [
          {
            origin: "https://example.com/",
            localStorage: [{ name: "local", value: "storage" }],
            indexedDB: [
              {
                name: "task4-db",
                stores: [
                  {
                    name: "records",
                    records: [{ key: "id", value: { restored: true } }],
                  },
                ],
              },
            ],
          },
        ],
      });
      gate.assertZeroViolations();
      expect(gate.snapshot().counters).toEqual({
        ingressAttempts: 0,
        ingressViolations: 0,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      });
      gate.open();
      expect(context.pages()).toHaveLength(1);
      expect(context.pages()[0]!.url()).toBe("about:blank");
    } finally {
      await context.close();
      await proxy.close();
    }
  }, 30_000);

  test.each(["replay", "non-replay", "non-replay-mobile"] as const)(
    "%s registry session proves final URL proxy ingress",
    async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "registry-chromium-"));
    roots.push(root);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>done</title><body>ok</body>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port");
    const finalUrl = `http://public.test:${address.port}/`;
    const state: StorageStateV1 = {
      cookies: [],
      origins: [
        {
          origin: `http://public.test:${address.port}`,
          localStorage: [{ name: "restored", value: "yes" }],
        },
      ],
    };
    const bytes = Buffer.from(canonicalJson(state));
    const statePath = `replay/owner/scrape/${CHECKPOINT_ID}.json`;
    await mkdir(join(root, "replay", "owner", "scrape"), { recursive: true });
    await writeFile(join(root, statePath), bytes);
    const processNonce = Buffer.alloc(32, 22).toString("base64url");
    const controlGenerationNonce = Buffer.alloc(32, 23).toString("base64url");
    const references = [
      {
        kind: "replay_checkpoint" as const,
        id: CHECKPOINT_ID,
        path: statePath,
        checksum: sha256(bytes),
      },
    ];
    const snapshotDigest = canonicalizeReconciliationSnapshot(
      references,
    ).snapshotDigest;
    const binding = {
      processNonce,
      controlGenerationNonce,
      snapshotDigest,
    };
    const reconciliationAdmission = {
      signal: new AbortController().signal,
      assertAdmitted: () => undefined,
    };
    const outcome = await reconcileBrowserStateWithAuthority(
      root,
      {
        version: 1,
        ...binding,
        references,
      },
      { admission: reconciliationAdmission },
    );
    let anchoredRoot: AnchoredProfileRoot | undefined;
    await consumeInternalReconciliationOutcome(
      outcome,
      binding,
      async (install) => {
        anchoredRoot = install.root;
      },
    );
    if (anchoredRoot === undefined) throw new Error("root install failed");
    const admission = {
      processNonce,
      requireReady: () => ({
        ...binding,
      }),
      beginDraining: () => undefined,
    };
    const store = await createProfileStore({ root: anchoredRoot, binding });
    let gateAtLaunch:
      | ReturnType<ReturnType<typeof createRestoreGate>["snapshot"]>
      | undefined;
    let launchPageUrls: string[] = [];
    let launchWorkerUrls: string[] = [];
    let contextOn: ReturnType<typeof vi.spyOn> | undefined;
    let contextNewPage: ReturnType<typeof vi.spyOn> | undefined;
    let activeGate: ReturnType<typeof createRestoreGate> | undefined;
    const registry = createSessionRegistry({
      admission,
      binding: { processNonce, controlGenerationNonce },
      profileStore: store,
      createEgressProxy: ({ restoreGate, allowedDomains }) => {
        activeGate = restoreGate;
        return createEgressProxy({
          restoreGate,
          allowedDomains,
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          dial: ({ port, signal }) =>
            connect({ host: "127.0.0.1", port, signal }),
        });
      },
      launchPersistentChromiumForWorking: async (...args) => {
        const attachment = await launchPersistentChromiumForWorking(...args);
        gateAtLaunch = activeGate?.snapshot();
        launchPageUrls = attachment.context.pages().map((page) => page.url());
        launchWorkerUrls = attachment.context
          .serviceWorkers()
          .map((worker) => worker.url());
        contextOn = vi.spyOn(attachment.context, "on");
        contextNewPage = vi.spyOn(attachment.context, "newPage");
        return attachment;
      },
    });
    try {
      const session = await registry.create({
        version: 1,
        sessionId: SESSION_V7,
        initialUrl: finalUrl,
        allowedDomains: ["public.test"],
        ttlSeconds: 60,
        activityTtlSeconds: 10,
        profile: null,
        replay: mode === "replay" ? {
          checkpointId: CHECKPOINT_ID,
          statePath,
          checksum: sha256(bytes),
          byteSize: bytes.length,
          storageState: state,
          finalUrl,
          fingerprint: {
            finalUrl,
            titleSha256: sha256("done"),
            bodyTextSha256: sha256("ok"),
          },
        } : null,
        settings: {
          headers: {},
          cookies: [],
          viewport: {
            width: mode === "non-replay-mobile" ? 390 : 1280,
            height: mode === "non-replay-mobile" ? 844 : 720,
            deviceScaleFactor: mode === "non-replay-mobile" ? 3 : 1,
            isMobile: mode === "non-replay-mobile",
            hasTouch: mode === "non-replay-mobile",
          },
          userAgent: "Browser Service Test",
          locale: "en-US",
          location: { country: "us-generic", languages: ["en-US"] },
          proxy: { kind: "auto" },
          skipTlsVerification: false,
          blockAds: false,
          lockdown: true,
        },
      });
      expect(session.page).toMatchObject({ url: finalUrl, title: "done" });
      expect(gateAtLaunch).toMatchObject({
        state: "restore_closed",
        counters: {
          ingressAttempts: 0,
          ingressViolations: 0,
          dnsResolutions: 0,
          policyDecisions: 0,
          dials: 0,
        },
      });
      expect(launchPageUrls).toEqual(["about:blank"]);
      expect(launchWorkerUrls).toEqual([]);
      expect(contextOn).not.toHaveBeenCalled();
      expect(contextNewPage).not.toHaveBeenCalled();
      await registry.close(session.runtimeSessionId, "requested");
      expect(await store.listWorking()).toEqual([]);
    } finally {
      await store.close();
      await closeAnchoredProfileRoot(anchoredRoot);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    },
    30_000,
  );
});
