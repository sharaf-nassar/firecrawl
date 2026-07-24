import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  ATOMIC_PUBLISH_INTENT_MAX_BYTES,
  CLEANUP_IDENTITY_MANIFEST_MAX_BYTES,
  CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES,
  encodeAtomicPublishIntent,
  encodeCleanupIdentityManifest,
  parseAtomicPublishIntent,
  parseAtomicPublicationIntentLeaf,
  parseAtomicPublicationWrapperLeaf,
  parseAtomicPublicationWrapperName,
  parseCleanupIdentityManifest,
  publicationTargetLocatorDigest,
  validateAtomicPublishIntentTransition,
  validateAtomicPublicationWrapperEntries,
  validateCleanupIdentityManifestBinding,
  type AtomicPublishPhaseV1,
  type AtomicPublishIntentV1,
  type CleanupIdentityManifestV1,
} from "./atomic-publication-manifest.js";

const OPERATION_ID = "018f47c8-7a42-4e36-8d21-4e8d5e13a921";
const PROFILE_ID = "018f47c8-7a42-5e36-8d21-4e8d5e13a922";
const GENERATION_ID = "018f47c8-7a42-4e36-8d21-4e8d5e13a923";
const TRANSITION_ID = "018f47c8-7a42-5e36-8d21-4e8d5e13a924";
const TOKEN_A = Buffer.alloc(32, 1).toString("base64url");
const TOKEN_B = Buffer.alloc(32, 2).toString("base64url");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function allocatedIntent(): AtomicPublishIntentV1 {
  return {
    version: 1,
    operationId: OPERATION_ID,
    kind: "working",
    phase: "allocated",
    binding: {
      processNonce: TOKEN_A,
      controlGenerationNonce: TOKEN_B,
      snapshotDigest: SHA_A,
    },
    target: {
      kind: "profile_state",
      profileId: PROFILE_ID,
      state: "working",
      generationId: GENERATION_ID,
      leaf: GENERATION_ID,
      parent: { dev: "1", ino: "2", mode: 448 },
    },
    wrapper: null,
    privateSource: null,
    publicSource: null,
    classification: null,
    sourceDeletion: null,
    adoption: null,
    cleanup: null,
    canaryProof: null,
    prepublicationAbort: null,
    identityManifest: null,
  };
}

function cleanupManifest(): CleanupIdentityManifestV1 {
  return {
    version: 1,
    operationId: OPERATION_ID,
    binding: {
      processNonce: TOKEN_A,
      controlGenerationNonce: TOKEN_B,
      snapshotDigest: SHA_A,
    },
    targetLocatorDigest: SHA_B,
    entries: [
      {
        index: 0,
        scope: "private_profile_payload",
        path: "data/file",
        type: "file",
        dev: "1",
        ino: "3",
        mode: 384,
        size: 3,
        contentSha256: SHA_C,
      },
      {
        index: 1,
        scope: "private_profile_payload",
        path: "data",
        type: "directory",
        dev: "1",
        ino: "4",
        mode: 448,
        size: 0,
        contentSha256: null,
      },
    ],
  };
}

function manifestPlannedBinding(): {
  intent: AtomicPublishIntentV1;
  manifest: CleanupIdentityManifestV1;
} {
  const allocated = allocatedIntent();
  const targetLocatorDigest = publicationTargetLocatorDigest(allocated.target);
  const manifest = { ...cleanupManifest(), targetLocatorDigest };
  const encoded = encodeCleanupIdentityManifest(manifest);
  return {
    manifest,
    intent: {
      ...allocated,
      phase: "manifest_planned",
      wrapper: { dev: "1", ino: "5", mode: 448 },
      privateSource: {
        dev: "1",
        ino: "6",
        mode: 448,
        checksum: SHA_C,
        byteSize: 0,
      },
      classification: {
        outcome: "published",
        nativeCode: "success",
        sourceMatches: false,
        targetMatches: true,
        targetOther: false,
        evidenceDigest: SHA_B,
      },
      identityManifest: {
        phase: "planned",
        filename: `${OPERATION_ID}.identities.json`,
        tempFilename: `${OPERATION_ID}.identities.${TRANSITION_ID}.tmp`,
        sha256: encoded.sha256,
        entryCount: encoded.entryCount,
        byteSize: encoded.bytes.byteLength,
        dev: null,
        ino: null,
        mode: null,
      },
    },
  };
}

function discardingIntent(): AtomicPublishIntentV1 {
  const { intent } = manifestPlannedBinding();
  return {
    ...intent,
    phase: "discarding",
    identityManifest: {
      ...intent.identityManifest!,
      phase: "published",
      dev: "1",
      ino: "7",
      mode: 384,
    },
    cleanup: {
      phase: "discarding",
      outcome: "released_to_reconciliation",
      evidenceDigest: SHA_A,
      suffix: "private_source_entries",
      nextIndex: 0,
    },
  };
}

function sourceDeletingIntent(
  kind: "prepare" | "finalize" = "prepare",
): AtomicPublishIntentV1 {
  const targetState = kind === "prepare" ? "staging" : "committed";
  const sourceState = kind === "prepare" ? "working" : "staging";
  return {
    ...allocatedIntent(),
    kind,
    phase: "source_deleting",
    target: {
      kind: "profile_state",
      profileId: PROFILE_ID,
      state: targetState,
      generationId: GENERATION_ID,
      leaf: GENERATION_ID,
      parent: { dev: "1", ino: "2", mode: 448 },
    },
    wrapper: { dev: "1", ino: "5", mode: 448 },
    privateSource: {
      dev: "1",
      ino: "6",
      mode: 448,
      checksum: SHA_C,
      byteSize: 7,
    },
    publicSource: {
      profileId: PROFILE_ID,
      state: sourceState,
      generationId: GENERATION_ID,
      dev: "1",
      ino: "8",
      mode: 448,
      checksum: SHA_C,
      byteSize: 7,
      capabilityDigest: SHA_B,
    },
    classification: {
      outcome: "published",
      nativeCode: "success",
      sourceMatches: false,
      targetMatches: true,
      targetOther: false,
      evidenceDigest: SHA_A,
    },
    sourceDeletion: {
      phase: "removing",
      privateDeletionLeaf: `delete-${OPERATION_ID}`,
      evidenceDigest: SHA_B,
      entryCount: 2,
      nextIndex: 2,
    },
    identityManifest: {
      phase: "published",
      filename: `${OPERATION_ID}.identities.json`,
      tempFilename: `${OPERATION_ID}.identities.${TRANSITION_ID}.tmp`,
      sha256: SHA_C,
      entryCount: 2,
      byteSize: 100,
      dev: "1",
      ino: "7",
      mode: 384,
    },
  };
}

type OperationKind = AtomicPublishIntentV1["kind"];

function allocatedIntentForKind(kind: OperationKind): AtomicPublishIntentV1 {
  const base = allocatedIntent();
  if (kind === "canary") {
    return {
      ...base,
      kind,
      target: {
        kind: "canary_parent",
        parentLocator: { kind: "profiles" },
        parent: { dev: "1", ino: "2", mode: 448 },
      },
      canaryProof: {
        attempt: 0,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        deletionLeaf: `deletion-${OPERATION_ID}-0`,
        phase: "planned",
        dev: null,
        ino: null,
        mode: null,
        evidenceDigest: null,
      },
    };
  }
  if (kind === "scaffold") {
    return {
      ...base,
      kind,
      target: {
        kind: "profile",
        profileId: PROFILE_ID,
        leaf: PROFILE_ID,
        parent: { dev: "1", ino: "2", mode: 448 },
      },
    };
  }
  const state =
    kind === "working"
      ? "working"
      : kind === "prepare"
        ? "staging"
        : "committed";
  const intent: AtomicPublishIntentV1 = {
    ...base,
    kind,
    target: {
      kind: "profile_state",
      profileId: PROFILE_ID,
      state,
      generationId: GENERATION_ID,
      leaf: GENERATION_ID,
      parent: { dev: "1", ino: "2", mode: 448 },
    },
  };
  if (kind !== "prepare" && kind !== "finalize") return intent;
  return {
    ...intent,
    publicSource: {
      profileId: PROFILE_ID,
      state: kind === "prepare" ? "working" : "staging",
      generationId: GENERATION_ID,
      dev: "1",
      ino: "8",
      mode: 448,
      checksum: SHA_C,
      byteSize: 7,
      capabilityDigest: SHA_B,
    },
  };
}

function validIntentForPhase(
  kind: OperationKind,
  phase: AtomicPublishPhaseV1,
): AtomicPublishIntentV1 {
  const base = allocatedIntentForKind(kind);
  const wrapper = { dev: "1", ino: "5", mode: 448 as const };
  const privateSource = {
    dev: "1",
    ino: "6",
    mode: 448 as const,
    checksum: SHA_C,
    byteSize: kind === "prepare" || kind === "finalize" ? 7 : 0,
  };
  const classification = {
    outcome: "published" as const,
    nativeCode: "success" as const,
    sourceMatches: false,
    targetMatches: true,
    targetOther: false,
    evidenceDigest: SHA_B,
  };
  const publishedCanaryProof =
    kind === "canary"
      ? {
          ...base.canaryProof!,
          phase: "published" as const,
          dev: "1",
          ino: "9",
          mode: 448 as const,
          evidenceDigest: SHA_A,
        }
      : null;
  const identityManifest = {
    phase: "published" as const,
    filename: `${OPERATION_ID}.identities.json`,
    tempFilename: `${OPERATION_ID}.identities.${TRANSITION_ID}.tmp`,
    sha256: SHA_C,
    entryCount: 2,
    byteSize: 100,
    dev: "1",
    ino: "7",
    mode: 384 as const,
  };
  const published: AtomicPublishIntentV1 = {
    ...base,
    phase: "manifest_published",
    wrapper,
    privateSource,
    classification,
    canaryProof: publishedCanaryProof,
    identityManifest,
  };
  switch (phase) {
    case "allocated":
      return base;
    case "building":
      return { ...base, phase, wrapper };
    case "aborting_prepublication":
      return {
        ...base,
        phase,
        prepublicationAbort: {
          outcome: "never_attempted",
          from: "allocated",
          evidenceDigest: SHA_A,
        },
        cleanup: {
          phase,
          outcome: "never_attempted",
          evidenceDigest: SHA_A,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      };
    case "ready":
      return { ...base, phase, wrapper, privateSource };
    case "classified":
    case "renamed":
      return {
        ...base,
        phase,
        wrapper,
        privateSource,
        classification,
        canaryProof: publishedCanaryProof,
      };
    case "manifest_planned":
      return {
        ...published,
        phase,
        identityManifest: {
          ...identityManifest,
          phase: "planned",
          dev: null,
          ino: null,
          mode: null,
        },
      };
    case "manifest_published":
      return published;
    case "source_deleting":
      return {
        ...published,
        phase,
        sourceDeletion: {
          phase: "pending",
          privateDeletionLeaf: `delete-${OPERATION_ID}`,
          evidenceDigest: SHA_A,
          entryCount: 2,
          nextIndex: 0,
        },
      };
    case "adopted":
      return {
        ...published,
        phase,
        sourceDeletion:
          kind === "prepare" || kind === "finalize"
            ? {
                phase: "removed",
                privateDeletionLeaf: `delete-${OPERATION_ID}`,
                evidenceDigest: SHA_A,
                entryCount: 2,
                nextIndex: 0,
              }
            : null,
        adoption: {
          authority:
            kind === "scaffold"
              ? "scaffold"
              : kind === "working"
                ? "registry"
                : kind === "prepare"
                  ? "prepare_token"
                  : "reconciliation_snapshot",
          authorityDigest: SHA_A,
        },
      };
    case "discarding":
      return {
        ...published,
        phase,
        sourceDeletion:
          kind === "prepare" || kind === "finalize"
            ? {
                phase: "removed",
                privateDeletionLeaf: `delete-${OPERATION_ID}`,
                evidenceDigest: SHA_A,
                entryCount: 2,
                nextIndex: 0,
              }
            : null,
        cleanup: {
          phase,
          outcome:
            kind === "canary"
              ? "canary_complete"
              : "released_to_reconciliation",
          evidenceDigest: SHA_A,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      };
    case "manifest_deleting":
    case "cleaned":
      return {
        ...published,
        phase,
        canaryProof:
          kind === "canary"
            ? { ...publishedCanaryProof!, phase: "cleaned" }
            : null,
        sourceDeletion:
          kind === "prepare" || kind === "finalize"
            ? {
                phase: "removed",
                privateDeletionLeaf: `delete-${OPERATION_ID}`,
                evidenceDigest: SHA_A,
                entryCount: 2,
                nextIndex: 0,
              }
            : null,
        cleanup: {
          phase: "cleaned",
          outcome:
            kind === "canary"
              ? "canary_complete"
              : "released_to_reconciliation",
          evidenceDigest: SHA_A,
          suffix: "done",
          nextIndex: 0,
        },
        identityManifest: { ...identityManifest, phase: "deleting" },
      };
  }
}

describe("atomic publication durable codecs", () => {
  const kinds = [
    "canary",
    "scaffold",
    "working",
    "prepare",
    "finalize",
  ] as const;
  const phases = [
    "allocated",
    "building",
    "aborting_prepublication",
    "ready",
    "classified",
    "renamed",
    "manifest_planned",
    "manifest_published",
    "source_deleting",
    "adopted",
    "discarding",
    "manifest_deleting",
    "cleaned",
  ] as const;

  it.each(
    phases.flatMap((phase) => kinds.map((kind) => [phase, kind] as const)),
  )("enforces phase table row %s for %s", (phase, kind) => {
    const allowed =
      phase !== "source_deleting"
        ? phase !== "adopted" || kind !== "canary"
        : kind === "prepare" || kind === "finalize";
    const encode = () =>
      encodeAtomicPublishIntent(validIntentForPhase(kind, phase));
    if (allowed) expect(encode).not.toThrow();
    else expect(encode).toThrow();
  });

  it("closes every publication target variant and kind binding", () => {
    for (const kind of kinds) {
      expect(() =>
        encodeAtomicPublishIntent(allocatedIntentForKind(kind)),
      ).not.toThrow();
    }
    const canary = allocatedIntentForKind("canary");
    for (const parentLocator of [
      { kind: "profiles" as const },
      {
        kind: "profile_state" as const,
        profileId: PROFILE_ID,
        state: "working" as const,
      },
      {
        kind: "profile_state" as const,
        profileId: PROFILE_ID,
        state: "staging" as const,
      },
      {
        kind: "profile_state" as const,
        profileId: PROFILE_ID,
        state: "committed" as const,
      },
    ]) {
      expect(() =>
        encodeAtomicPublishIntent({
          ...canary,
          target: { ...canary.target, parentLocator },
        } as AtomicPublishIntentV1),
      ).not.toThrow();
    }
    for (const invalid of [
      {
        ...allocatedIntentForKind("canary"),
        target: allocatedIntentForKind("working").target,
      },
      {
        ...allocatedIntentForKind("scaffold"),
        target: {
          ...allocatedIntentForKind("scaffold").target,
          leaf: GENERATION_ID,
        },
      },
      {
        ...allocatedIntentForKind("working"),
        target: allocatedIntentForKind("finalize").target,
      },
      {
        ...allocatedIntentForKind("prepare"),
        target: allocatedIntentForKind("finalize").target,
      },
      {
        ...allocatedIntentForKind("finalize"),
        target: allocatedIntentForKind("prepare").target,
      },
    ]) {
      expect(() =>
        encodeAtomicPublishIntent(invalid as AtomicPublishIntentV1),
      ).toThrow(/target/u);
    }
  });

  it("enforces kind-wide public source and canary proof nullability", () => {
    for (const phase of phases) {
      for (const kind of kinds) {
        const allowed =
          phase !== "source_deleting"
            ? phase !== "adopted" || kind !== "canary"
            : kind === "prepare" || kind === "finalize";
        if (!allowed) continue;
        const intent = validIntentForPhase(kind, phase);
        if (kind === "prepare" || kind === "finalize") {
          expect(() =>
            encodeAtomicPublishIntent({ ...intent, publicSource: null }),
          ).toThrow(/publicSource/u);
        } else {
          expect(() =>
            encodeAtomicPublishIntent({
              ...intent,
              publicSource: allocatedIntentForKind("prepare").publicSource,
            }),
          ).toThrow(/publicSource/u);
        }
        if (kind === "canary") {
          expect(() =>
            encodeAtomicPublishIntent({ ...intent, canaryProof: null }),
          ).toThrow(/canaryProof/u);
        } else {
          expect(() =>
            encodeAtomicPublishIntent({
              ...intent,
              canaryProof: allocatedIntentForKind("canary").canaryProof,
            }),
          ).toThrow(/canaryProof/u);
        }
      }
    }
  });

  it("closes required and forbidden nullable fields in every phase row", () => {
    const samples = {
      wrapper: validIntentForPhase("working", "ready").wrapper,
      privateSource: validIntentForPhase("working", "ready").privateSource,
      classification: validIntentForPhase("working", "classified")
        .classification,
      sourceDeletion: validIntentForPhase("prepare", "source_deleting")
        .sourceDeletion,
      adoption: validIntentForPhase("working", "adopted").adoption,
      cleanup: validIntentForPhase("working", "discarding").cleanup,
      prepublicationAbort: validIntentForPhase(
        "working",
        "aborting_prepublication",
      ).prepublicationAbort,
      identityManifest: validIntentForPhase("working", "manifest_planned")
        .identityManifest,
    } as const;
    type NullableField = keyof typeof samples;
    const rows: readonly Readonly<{
      phase: AtomicPublishPhaseV1;
      kind: OperationKind;
      required: readonly NullableField[];
      forbidden: readonly NullableField[];
    }>[] = [
      {
        phase: "allocated",
        kind: "working",
        required: [],
        forbidden: Object.keys(samples) as NullableField[],
      },
      {
        phase: "building",
        kind: "working",
        required: ["wrapper"],
        forbidden: [
          "privateSource",
          "classification",
          "sourceDeletion",
          "adoption",
          "cleanup",
          "prepublicationAbort",
          "identityManifest",
        ],
      },
      {
        phase: "aborting_prepublication",
        kind: "working",
        required: ["cleanup", "prepublicationAbort"],
        forbidden: [
          "wrapper",
          "privateSource",
          "classification",
          "sourceDeletion",
          "adoption",
          "identityManifest",
        ],
      },
      {
        phase: "ready",
        kind: "working",
        required: ["wrapper", "privateSource"],
        forbidden: [
          "classification",
          "sourceDeletion",
          "adoption",
          "cleanup",
          "prepublicationAbort",
          "identityManifest",
        ],
      },
      ...(["classified", "renamed"] as const).map((phase) => ({
        phase,
        kind: "working" as const,
        required: ["wrapper", "privateSource", "classification"] as const,
        forbidden: [
          "sourceDeletion",
          "adoption",
          "cleanup",
          "prepublicationAbort",
          "identityManifest",
        ] as const,
      })),
      ...(["manifest_planned", "manifest_published"] as const).map((phase) => ({
        phase,
        kind: "working" as const,
        required: [
          "wrapper",
          "privateSource",
          "classification",
          "identityManifest",
        ] as const,
        forbidden: [
          "sourceDeletion",
          "adoption",
          "cleanup",
          "prepublicationAbort",
        ] as const,
      })),
      {
        phase: "source_deleting",
        kind: "prepare",
        required: [
          "wrapper",
          "privateSource",
          "classification",
          "sourceDeletion",
          "identityManifest",
        ],
        forbidden: ["adoption", "cleanup", "prepublicationAbort"],
      },
      {
        phase: "adopted",
        kind: "working",
        required: [
          "wrapper",
          "privateSource",
          "classification",
          "adoption",
          "identityManifest",
        ],
        forbidden: ["sourceDeletion", "cleanup", "prepublicationAbort"],
      },
      ...(["discarding", "manifest_deleting", "cleaned"] as const).map(
        (phase) => ({
          phase,
          kind: "working" as const,
          required: [
            "wrapper",
            "privateSource",
            "classification",
            "cleanup",
            "identityManifest",
          ] as const,
          forbidden: ["sourceDeletion", "prepublicationAbort"] as const,
        }),
      ),
    ];
    for (const { phase, kind, required, forbidden } of rows) {
      const intent = validIntentForPhase(kind, phase);
      for (const field of required) {
        expect(() =>
          encodeAtomicPublishIntent({
            ...intent,
            [field]: null,
          } as AtomicPublishIntentV1),
        ).toThrow();
      }
      for (const field of forbidden) {
        expect(() =>
          encodeAtomicPublishIntent({
            ...intent,
            [field]: samples[field],
          } as AtomicPublishIntentV1),
        ).toThrow();
      }
    }
  });

  it.each(["prepare", "finalize"] as const)(
    "accepts every %s source-deletion subphase and exact authority",
    (kind) => {
      for (const phase of [
        "pending",
        "moved_private",
        "removing",
        "removed",
      ] as const) {
        const intent = validIntentForPhase(kind, "source_deleting");
        expect(() =>
          encodeAtomicPublishIntent({
            ...intent,
            sourceDeletion: {
              ...intent.sourceDeletion!,
              phase,
              nextIndex: phase === "removing" ? 2 : 0,
            },
          }),
        ).not.toThrow();
      }
    },
  );

  it("closes adoption authority by operation kind", () => {
    const validAuthorities = [
      ["scaffold", "scaffold"],
      ["working", "registry"],
      ["prepare", "prepare_token"],
      ["prepare", "reconciliation_snapshot"],
      ["finalize", "reconciliation_snapshot"],
    ] as const;
    for (const [kind, authority] of validAuthorities) {
      const intent = validIntentForPhase(kind, "adopted");
      expect(() =>
        encodeAtomicPublishIntent({
          ...intent,
          adoption: { authority, authorityDigest: SHA_A },
        }),
      ).not.toThrow();
    }
    for (const [kind, authority] of [
      ["scaffold", "registry"],
      ["working", "scaffold"],
      ["prepare", "registry"],
      ["finalize", "prepare_token"],
    ] as const) {
      const intent = validIntentForPhase(kind, "adopted");
      expect(() =>
        encodeAtomicPublishIntent({
          ...intent,
          adoption: { authority, authorityDigest: SHA_A },
        }),
      ).toThrow(/authority/u);
    }
  });

  it("encodes and parses exact canonical intent bytes", () => {
    const encoded = encodeAtomicPublishIntent(allocatedIntent());
    expect(encoded.bytes.at(-1)).toBe(0x0a);
    expect(encoded.bytes.toString("utf8")).not.toContain(" ");
    expect(parseAtomicPublishIntent(encoded.bytes)).toEqual(allocatedIntent());
    expect(encoded.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("encodes and parses an authenticated cleanup manifest", () => {
    const encoded = encodeCleanupIdentityManifest(cleanupManifest());
    expect(encoded.entryCount).toBe(2);
    expect(encoded.bytes.at(-1)).toBe(0x0a);
    expect(parseCleanupIdentityManifest(encoded.bytes)).toEqual(
      cleanupManifest(),
    );
  });

  it.each([
    Buffer.from("\ufeff{}\n"),
    Buffer.from('{"version":1,"version":1}\n'),
    Buffer.from('{"version":1, "operationId":"x"}\n'),
    Buffer.from("{}"),
  ])("rejects noncanonical durable bytes", (bytes) => {
    expect(() => parseAtomicPublishIntent(bytes)).toThrow();
    expect(() => parseCleanupIdentityManifest(bytes)).toThrow();
  });

  it("rejects canonical-byte tampering of otherwise valid records", () => {
    const intentBytes = encodeAtomicPublishIntent(allocatedIntent()).bytes;
    const intentText = intentBytes.toString("utf8");
    for (const changed of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), intentBytes]),
      Buffer.from(
        intentText.replace('{"version":1,', '{"version":1,"version":1,'),
      ),
      Buffer.from(intentText.replace('"operationId"', ' "operationId"')),
      intentBytes.subarray(0, -1),
    ]) {
      expect(() => parseAtomicPublishIntent(changed)).toThrow(
        /canonical|JSON/u,
      );
    }
    const manifestBytes =
      encodeCleanupIdentityManifest(cleanupManifest()).bytes;
    expect(() =>
      parseCleanupIdentityManifest(
        Buffer.from(
          manifestBytes
            .toString("utf8")
            .replace('{"version":1,', '{"version":1,"version":1,'),
        ),
      ),
    ).toThrow(/canonical/u);
  });

  it("rejects noncanonical UUID, SHA, and startup tokens", () => {
    const allocated = allocatedIntent();
    for (const changed of [
      { ...allocated, operationId: OPERATION_ID.toUpperCase() },
      {
        ...allocated,
        operationId: "018f47c8-7a42-7e36-8d21-4e8d5e13a921",
      },
      {
        ...allocated,
        operationId: "00000000-0000-0000-0000-000000000000",
      },
      {
        ...allocated,
        operationId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      },
      {
        ...allocated,
        binding: { ...allocated.binding, snapshotDigest: SHA_A.toUpperCase() },
      },
      {
        ...allocated,
        binding: { ...allocated.binding, processNonce: "a".repeat(42) },
      },
    ]) {
      expect(() => encodeAtomicPublishIntent(changed)).toThrow();
    }
  });

  it("rejects skipped lifecycle transitions and immutable drift", () => {
    const allocated = allocatedIntent();
    const ready = {
      ...allocated,
      phase: "ready",
      wrapper: { dev: "1", ino: "5", mode: 448 },
      privateSource: {
        dev: "1",
        ino: "6",
        mode: 448,
        checksum: SHA_C,
        byteSize: 0,
      },
    } satisfies AtomicPublishIntentV1;
    expect(() =>
      validateAtomicPublishIntentTransition(allocated, ready),
    ).toThrow(/transition/u);
    expect(() =>
      validateAtomicPublishIntentTransition(allocated, {
        ...allocated,
        operationId: PROFILE_ID,
      }),
    ).toThrow(/immutable/u);
  });

  it("rejects byte-identical same-phase recovery rewrites", () => {
    const sourceDeleting = sourceDeletingIntent();
    expect(() =>
      validateAtomicPublishIntentTransition(sourceDeleting, sourceDeleting),
    ).toThrow(/progress/u);
    const discarding = discardingIntent();
    expect(() =>
      validateAtomicPublishIntentTransition(discarding, discarding),
    ).toThrow(/progress/u);
  });

  it("allows exactly one same-phase durable progress unit", () => {
    const discarding = validIntentForPhase("canary", "discarding");
    const cleanupProgress: AtomicPublishIntentV1 = {
      ...discarding,
      cleanup: { ...discarding.cleanup!, nextIndex: 1 },
    };
    expect(
      validateAtomicPublishIntentTransition(discarding, cleanupProgress),
    ).toEqual(cleanupProgress);
    const proofProgress: AtomicPublishIntentV1 = {
      ...discarding,
      canaryProof: { ...discarding.canaryProof!, phase: "deleting" },
    };
    expect(
      validateAtomicPublishIntentTransition(discarding, proofProgress),
    ).toEqual(proofProgress);
    expect(() =>
      validateAtomicPublishIntentTransition(discarding, {
        ...cleanupProgress,
        canaryProof: proofProgress.canaryProof,
      }),
    ).toThrow(/one durable progress unit/u);
  });

  it.each([
    "data//file",
    "data/../file",
    "data\\file",
    `data/${"x".repeat(256)}`,
    "data/e\u0301",
  ])("rejects invalid cleanup path %s", (path) => {
    const manifest = cleanupManifest();
    const invalid = {
      ...manifest,
      entries: [{ ...manifest.entries[0]!, path }],
    };
    expect(() => encodeCleanupIdentityManifest(invalid)).toThrow();
  });

  it("rejects noncontiguous, duplicate, prefix-file, and non-postorder entries", () => {
    const manifest = cleanupManifest();
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, index: 1 }],
      }),
    ).toThrow(/index/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [manifest.entries[0]!, { ...manifest.entries[0]!, index: 1 }],
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          manifest.entries[0]!,
          {
            ...manifest.entries[1]!,
            index: 1,
            path: "data",
            type: "file",
            contentSha256: SHA_A,
          },
        ],
      }),
    ).toThrow(/prefix/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          { ...manifest.entries[1]!, index: 0 },
          { ...manifest.entries[0]!, index: 1 },
        ],
      }),
    ).toThrow(/postorder/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          { ...manifest.entries[0]!, path: "z" },
          { ...manifest.entries[1]!, path: "a" },
        ],
      }),
    ).toThrow(/UTF-8/u);
  });

  it("rejects unknown durable fields and in-memory authority IDs", () => {
    expect(() =>
      encodeAtomicPublishIntent({
        ...allocatedIntent(),
        effectId: { effect: true },
      } as AtomicPublishIntentV1),
    ).toThrow(/fields/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...cleanupManifest(),
        semanticId: {},
      } as CleanupIdentityManifestV1),
    ).toThrow(/fields/u);
    const branded = allocatedIntent() as AtomicPublishIntentV1 & {
      [key: symbol]: true;
    };
    Object.defineProperty(branded, Symbol("flightEffectId"), {
      value: true,
      enumerable: false,
    });
    expect(() => encodeAtomicPublishIntent(branded)).toThrow(/fields/u);
    const hiddenVersion = { ...allocatedIntent() };
    Object.defineProperty(hiddenVersion, "version", {
      value: 1,
      enumerable: false,
    });
    expect(() =>
      encodeAtomicPublishIntent(hiddenVersion as AtomicPublishIntentV1),
    ).toThrow(/enumerable/u);
    const entries = [...cleanupManifest().entries];
    Object.defineProperty(entries, Symbol("flightSemanticId"), {
      value: true,
      enumerable: false,
    });
    expect(() =>
      encodeCleanupIdentityManifest({
        ...cleanupManifest(),
        entries,
      }),
    ).toThrow(/symbolic/u);
  });

  it("binds the manifest operation and startup authority in canonical bytes", () => {
    const encoded = encodeCleanupIdentityManifest(cleanupManifest());
    expect(encoded.bytes.toString("utf8")).toContain(
      `"operationId":"${OPERATION_ID}"`,
    );
    expect(encoded.bytes.toString("utf8")).toContain(
      `"processNonce":"${TOKEN_A}"`,
    );
    expect(encoded.bytes.toString("utf8")).toContain(
      `"targetLocatorDigest":"${SHA_B}"`,
    );
    expect(encoded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(TRANSITION_ID).not.toBe(OPERATION_ID);
  });

  it("authenticates manifest operation, binding, target, hash, count, and size", () => {
    const { intent, manifest } = manifestPlannedBinding();
    expect(validateCleanupIdentityManifestBinding(intent, manifest)).toEqual(
      manifest,
    );
    for (const changed of [
      { ...manifest, operationId: PROFILE_ID },
      {
        ...manifest,
        binding: { ...manifest.binding, snapshotDigest: SHA_C },
      },
      { ...manifest, targetLocatorDigest: SHA_C },
    ]) {
      expect(() =>
        validateCleanupIdentityManifestBinding(intent, changed),
      ).toThrow(/binding mismatch/u);
    }
    expect(() =>
      validateCleanupIdentityManifestBinding(
        {
          ...intent,
          identityManifest: {
            ...intent.identityManifest!,
            entryCount: intent.identityManifest!.entryCount + 1,
          },
        },
        manifest,
      ),
    ).toThrow(/binding mismatch/u);
    for (const identityManifest of [
      { ...intent.identityManifest!, sha256: SHA_A },
      {
        ...intent.identityManifest!,
        byteSize: intent.identityManifest!.byteSize + 1,
      },
    ]) {
      expect(() =>
        validateCleanupIdentityManifestBinding(
          { ...intent, identityManifest },
          manifest,
        ),
      ).toThrow(/binding mismatch/u);
    }
  });

  it.each(["manifest_published", "manifest_deleting"] as const)(
    "requires stable identity manifest mode 0600 in %s",
    (phase) => {
      const intent = validIntentForPhase("prepare", phase);
      expect(intent.identityManifest?.mode).toBe(384);
      expect(() => encodeAtomicPublishIntent(intent)).not.toThrow();

      expect(() =>
        encodeAtomicPublishIntent({
          ...intent,
          identityManifest: {
            ...intent.identityManifest!,
            mode: 448,
          },
        } as unknown as AtomicPublishIntentV1),
      ).toThrow(/identityManifest.*mode 384/u);
    },
  );

  it("rejects kind-target, normalized-code, mode, and adoption mismatches", () => {
    const allocated = allocatedIntent();
    expect(() =>
      encodeAtomicPublishIntent({
        ...allocated,
        kind: "scaffold",
      }),
    ).toThrow(/scaffold/u);
    expect(() =>
      encodeAtomicPublishIntent({
        ...allocated,
        target: {
          ...allocated.target,
          parent: { ...allocated.target.parent, mode: 384 },
        },
      } as AtomicPublishIntentV1),
    ).toThrow(/mode/u);
    const { intent } = manifestPlannedBinding();
    expect(() =>
      encodeAtomicPublishIntent({
        ...intent,
        phase: "classified",
        identityManifest: null,
        classification: {
          ...intent.classification!,
          nativeCode: "atomic_publish_exists",
        },
      }),
    ).toThrow(/exists/u);
    expect(() =>
      encodeAtomicPublishIntent({
        ...intent,
        phase: "adopted",
        identityManifest: {
          ...intent.identityManifest!,
          phase: "published",
          dev: "1",
          ino: "7",
          mode: 384,
        },
        adoption: {
          authority: "reconciliation_snapshot",
          authorityDigest: SHA_A,
        },
      }),
    ).toThrow(/authority/u);
  });

  it("closes every durable native classification code and outcome tuple", () => {
    const { intent } = manifestPlannedBinding();
    const classified: AtomicPublishIntentV1 = {
      ...intent,
      phase: "classified",
      identityManifest: null,
    };
    const otherFailureCodes = [
      "atomic_publish_unsupported",
      "atomic_publish_cross_device",
      "atomic_publish_binding_invalid",
      "atomic_publish_denied",
      "atomic_publish_invalid_argument",
      "atomic_publish_io",
    ] as const;
    for (const nativeCode of otherFailureCodes) {
      expect(() =>
        encodeAtomicPublishIntent({
          ...classified,
          classification: {
            outcome: "unpublished",
            nativeCode,
            sourceMatches: true,
            targetMatches: false,
            targetOther: false,
            evidenceDigest: SHA_B,
          },
        }),
      ).not.toThrow();
      expect(() =>
        encodeAtomicPublishIntent({
          ...classified,
          classification: {
            outcome: "ambiguous",
            nativeCode,
            sourceMatches: false,
            targetMatches: false,
            targetOther: false,
            evidenceDigest: SHA_B,
          },
        }),
      ).not.toThrow();
      expect(() =>
        encodeAtomicPublishIntent({
          ...classified,
          classification: {
            outcome: "conflict",
            nativeCode,
            sourceMatches: true,
            targetMatches: false,
            targetOther: true,
            evidenceDigest: SHA_B,
          },
        }),
      ).toThrow(/requires native exists/u);
      expect(() =>
        encodeAtomicPublishIntent({
          ...classified,
          classification: {
            outcome: "published",
            nativeCode,
            sourceMatches: false,
            targetMatches: true,
            targetOther: false,
            evidenceDigest: SHA_B,
          },
        }),
      ).not.toThrow();
    }
    expect(() =>
      encodeAtomicPublishIntent({
        ...classified,
        classification: {
          outcome: "published",
          nativeCode: "success",
          sourceMatches: false,
          targetMatches: true,
          targetOther: false,
          evidenceDigest: SHA_B,
        },
      }),
    ).not.toThrow();
    expect(() =>
      encodeAtomicPublishIntent({
        ...classified,
        classification: {
          outcome: "conflict",
          nativeCode: "atomic_publish_exists",
          sourceMatches: true,
          targetMatches: false,
          targetOther: true,
          evidenceDigest: SHA_B,
        },
      }),
    ).not.toThrow();
    expect(() =>
      encodeAtomicPublishIntent({
        ...classified,
        classification: {
          outcome: "unpublished",
          nativeCode: "atomic_publish_exists",
          sourceMatches: true,
          targetMatches: false,
          targetOther: false,
          evidenceDigest: SHA_B,
        },
      }),
    ).toThrow(/exists/u);
    expect(() =>
      encodeAtomicPublishIntent({
        ...classified,
        classification: {
          ...classified.classification!,
          nativeCode: "source_missing",
        },
      } as unknown as AtomicPublishIntentV1),
    ).toThrow(/nativeCode/u);

    const replay: AtomicPublishIntentV1 = {
      ...classified,
      kind: "canary",
      target: {
        kind: "canary_parent",
        parentLocator: { kind: "profiles" },
        parent: { dev: "1", ino: "2", mode: 448 },
      },
      canaryProof: {
        attempt: 0,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        deletionLeaf: `deletion-${OPERATION_ID}-0`,
        phase: "published",
        dev: "1",
        ino: "9",
        mode: 448,
        evidenceDigest: SHA_A,
      },
      classification: {
        outcome: "published",
        nativeCode: "atomic_publish_replay_completed",
        sourceMatches: false,
        targetMatches: true,
        targetOther: false,
        evidenceDigest: SHA_B,
      },
    };
    expect(() => encodeAtomicPublishIntent(replay)).not.toThrow();
    expect(() =>
      encodeAtomicPublishIntent({
        ...classified,
        classification: replay.classification,
      }),
    ).toThrow(/canary-published/u);
  });

  it("rejects every path, depth, entry-count, and encoded-byte plus one", () => {
    const manifest = cleanupManifest();
    const pathAtMaximum = Array.from({ length: 5 }, () => "x".repeat(204)).join(
      "/",
    );
    expect(Buffer.byteLength(pathAtMaximum, "utf8")).toBe(1_024);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          {
            ...manifest.entries[0]!,
            path: `${pathAtMaximum.slice(0, -1)}xx`,
          },
        ],
      }),
    ).toThrow(/path/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          {
            ...manifest.entries[0]!,
            path: Array.from({ length: 65 }, () => "x").join("/"),
          },
        ],
      }),
    ).toThrow(/segment/u);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: Array.from(
          { length: CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES + 1 },
          (_, index) => ({
            ...manifest.entries[0]!,
            index,
            path: `x-${index}`,
          }),
        ),
      }),
    ).toThrow(/count/u);
    expect(() =>
      parseCleanupIdentityManifest(
        Buffer.alloc(CLEANUP_IDENTITY_MANIFEST_MAX_BYTES + 1),
      ),
    ).toThrow(/size/u);
    expect(() =>
      parseAtomicPublishIntent(
        Buffer.alloc(ATOMIC_PUBLISH_INTENT_MAX_BYTES + 1),
      ),
    ).toThrow(/size/u);
    const sparseEntries: CleanupIdentityManifestV1["entries"] = [];
    (sparseEntries as unknown[]).length =
      CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES + 1;
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: sparseEntries,
      }),
    ).toThrow(/count/u);
  });

  it("rejects noncanonical decimals, unsafe numbers, and file-size plus one", () => {
    const manifest = cleanupManifest();
    for (const changed of [
      { ...manifest.entries[0]!, dev: "01" },
      { ...manifest.entries[0]!, ino: "-1" },
      { ...manifest.entries[0]!, index: Number.MAX_SAFE_INTEGER + 1 },
      { ...manifest.entries[0]!, size: -0 },
      { ...manifest.entries[0]!, size: 64 * 1024 * 1024 + 1 },
    ]) {
      expect(() =>
        encodeCleanupIdentityManifest({
          ...manifest,
          entries: [changed],
        }),
      ).toThrow();
    }
  });

  it("rejects abort authority mixtures and lost origin evidence", () => {
    const { intent } = manifestPlannedBinding();
    expect(() =>
      encodeAtomicPublishIntent({
        ...intent,
        prepublicationAbort: {
          outcome: "never_attempted",
          from: "building",
          evidenceDigest: SHA_A,
        },
        cleanup: {
          phase: "aborting_prepublication",
          outcome: "never_attempted",
          evidenceDigest: SHA_B,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      }),
    ).toThrow(/publication authority/u);
    expect(() =>
      encodeAtomicPublishIntent({
        ...intent,
        classification: null,
        wrapper: null,
        privateSource: null,
        prepublicationAbort: {
          outcome: "never_attempted",
          from: "building",
          evidenceDigest: SHA_A,
        },
        cleanup: {
          phase: "aborting_prepublication",
          outcome: "never_attempted",
          evidenceDigest: SHA_B,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      }),
    ).toThrow(/inherit/u);
  });

  it("binds cursors to manifest count and rejects skipped cleanup transitions", () => {
    const discarding = discardingIntent();
    expect(() =>
      encodeAtomicPublishIntent({
        ...discarding,
        cleanup: { ...discarding.cleanup!, nextIndex: 3 },
      }),
    ).toThrow(/entryCount/u);
    expect(() =>
      validateAtomicPublishIntentTransition(discarding, {
        ...discarding,
        cleanup: {
          ...discarding.cleanup!,
          suffix: "wrapper_root",
          nextIndex: 0,
        },
      }),
    ).toThrow(/skipped/u);
    expect(() =>
      validateAtomicPublishIntentTransition(discarding, {
        ...discarding,
        cleanup: {
          ...discarding.cleanup!,
          evidenceDigest: SHA_C,
          nextIndex: 1,
        },
      }),
    ).toThrow(/immutable/u);
  });

  it("rejects every premature entry-cursor boundary", () => {
    const removing = {
      ...sourceDeletingIntent(),
      sourceDeletion: {
        ...sourceDeletingIntent().sourceDeletion!,
        nextIndex: 1,
      },
    };
    expect(() =>
      validateAtomicPublishIntentTransition(removing, {
        ...removing,
        sourceDeletion: {
          ...removing.sourceDeletion,
          phase: "removed",
          nextIndex: 0,
        },
      }),
    ).toThrow(/entry cursor/u);

    const discarding = discardingIntent();
    for (const [suffix, nextSuffix] of [
      ["private_source_entries", "private_source_root"],
      ["wrapper_temps", "wrapper_root"],
      ["intent_temps", "done"],
    ] as const) {
      const previous: AtomicPublishIntentV1 = {
        ...discarding,
        cleanup: { ...discarding.cleanup!, suffix, nextIndex: 1 },
      };
      expect(() =>
        validateAtomicPublishIntentTransition(previous, {
          ...previous,
          cleanup: {
            ...previous.cleanup!,
            suffix: nextSuffix,
            nextIndex: 0,
          },
        }),
      ).toThrow(/incomplete entry cursor/u);
    }
  });

  it("requires initial durable cursors and adopted-phase authority", () => {
    const { intent } = manifestPlannedBinding();
    const manifestPublished: AtomicPublishIntentV1 = {
      ...intent,
      phase: "manifest_published",
      identityManifest: {
        ...intent.identityManifest!,
        phase: "published",
        dev: "1",
        ino: "7",
        mode: 384,
      },
    };
    expect(() =>
      validateAtomicPublishIntentTransition(manifestPublished, {
        ...discardingIntent(),
        cleanup: {
          ...discardingIntent().cleanup!,
          suffix: "done",
          nextIndex: 0,
        },
      }),
    ).toThrow(/must start/u);
    expect(() =>
      validateAtomicPublishIntentTransition(manifestPublished, {
        ...discardingIntent(),
        adoption: {
          authority: "registry",
          authorityDigest: SHA_C,
        },
        cleanup: {
          ...discardingIntent().cleanup!,
          outcome: "adopted",
        },
      }),
    ).toThrow(/adopted phase/u);
  });

  it("permits only the explicit empty prepublication-abort jump", () => {
    const allocated = allocatedIntent();
    const aborting: AtomicPublishIntentV1 = {
      ...allocated,
      phase: "aborting_prepublication",
      prepublicationAbort: {
        outcome: "never_attempted",
        from: "allocated",
        evidenceDigest: SHA_A,
      },
      cleanup: {
        phase: "aborting_prepublication",
        outcome: "never_attempted",
        evidenceDigest: SHA_B,
        suffix: "private_source_entries",
        nextIndex: 0,
      },
    };
    const cleaned: AtomicPublishIntentV1 = {
      ...aborting,
      phase: "cleaned",
      cleanup: {
        ...aborting.cleanup!,
        phase: "cleaned",
        suffix: "done",
      },
    };
    expect(validateAtomicPublishIntentTransition(allocated, aborting)).toEqual(
      aborting,
    );
    const building: AtomicPublishIntentV1 = {
      ...allocated,
      phase: "building",
      wrapper: { dev: "1", ino: "5", mode: 448 },
    };
    const buildingAbort: AtomicPublishIntentV1 = {
      ...building,
      phase: "aborting_prepublication",
      prepublicationAbort: {
        outcome: "never_attempted",
        from: "building",
        evidenceDigest: SHA_A,
      },
      cleanup: aborting.cleanup,
    };
    expect(
      validateAtomicPublishIntentTransition(building, buildingAbort),
    ).toEqual(buildingAbort);
    expect(validateAtomicPublishIntentTransition(aborting, cleaned)).toEqual(
      cleaned,
    );
  });

  it("binds zero-entry manifests only to empty building aborts", () => {
    const building: AtomicPublishIntentV1 = {
      ...allocatedIntent(),
      phase: "building",
      wrapper: { dev: "1", ino: "5", mode: 448 },
    };
    const aborting: AtomicPublishIntentV1 = {
      ...building,
      phase: "aborting_prepublication",
      prepublicationAbort: {
        outcome: "never_attempted",
        from: "building",
        evidenceDigest: SHA_A,
      },
      cleanup: {
        phase: "aborting_prepublication",
        outcome: "never_attempted",
        evidenceDigest: SHA_B,
        suffix: "private_source_entries",
        nextIndex: 0,
      },
    };
    const manifest: CleanupIdentityManifestV1 = {
      version: 1,
      operationId: OPERATION_ID,
      binding: building.binding,
      targetLocatorDigest: publicationTargetLocatorDigest(building.target),
      entries: [],
    };
    const encoded = encodeCleanupIdentityManifest(manifest);
    const planned: AtomicPublishIntentV1 = {
      ...aborting,
      phase: "manifest_planned",
      identityManifest: {
        phase: "planned",
        filename: `${OPERATION_ID}.identities.json`,
        tempFilename: `${OPERATION_ID}.identities.${TRANSITION_ID}.tmp`,
        sha256: encoded.sha256,
        entryCount: 0,
        byteSize: encoded.bytes.byteLength,
        dev: null,
        ino: null,
        mode: null,
      },
    };
    expect(validateAtomicPublishIntentTransition(aborting, planned)).toEqual(
      planned,
    );
    expect(() =>
      encodeAtomicPublishIntent({
        ...planned,
        prepublicationAbort: null,
        classification: {
          outcome: "unpublished",
          nativeCode: "atomic_publish_unsupported",
          sourceMatches: true,
          targetMatches: false,
          targetOther: false,
          evidenceDigest: SHA_C,
        },
      }),
    ).toThrow(/empty identity manifest/u);
  });

  it("uses the shared canonical profile permission-bit range", () => {
    const manifest = cleanupManifest();
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, mode: 0o1_000 }],
      }),
    ).toThrow(/mode/u);
  });

  it("parses only closed intent, temp, identity, wrapper, and leaf names", () => {
    expect(parseAtomicPublicationWrapperName(OPERATION_ID)).toBe(OPERATION_ID);
    expect(parseAtomicPublicationIntentLeaf(`${OPERATION_ID}.json`)).toEqual({
      kind: "intent_stable",
      operationId: OPERATION_ID,
    });
    expect(
      parseAtomicPublicationIntentLeaf(
        `${OPERATION_ID}.ready.${TRANSITION_ID}.tmp`,
      ),
    ).toEqual({
      kind: "intent_temp",
      operationId: OPERATION_ID,
      phase: "ready",
      transitionId: TRANSITION_ID,
    });
    expect(
      parseAtomicPublicationIntentLeaf(`${OPERATION_ID}.identities.json`),
    ).toEqual({ kind: "identity_stable", operationId: OPERATION_ID });
    expect(
      parseAtomicPublicationIntentLeaf(
        `${OPERATION_ID}.identities.${TRANSITION_ID}.tmp`,
      ),
    ).toEqual({
      kind: "identity_temp",
      operationId: OPERATION_ID,
      transitionId: TRANSITION_ID,
    });
    expect(
      parseAtomicPublicationWrapperLeaf(allocatedIntent(), "payload"),
    ).toEqual({ kind: "profile_payload", leaf: "payload" });
    expect(
      validateAtomicPublicationWrapperEntries(
        validIntentForPhase("prepare", "ready"),
        ["payload", `delete-${OPERATION_ID}`],
      ).map(({ kind }) => kind),
    ).toEqual(["profile_payload", "profile_deletion"]);
    expect(
      validateAtomicPublicationWrapperEntries(
        validIntentForPhase("finalize", "ready"),
        ["payload", `delete-${OPERATION_ID}`],
      ).map(({ kind }) => kind),
    ).toEqual(["profile_payload", "profile_deletion"]);
    expect(
      validateAtomicPublicationWrapperEntries(
        validIntentForPhase("canary", "ready"),
        [`proof-${OPERATION_ID}-0`, `deletion-${OPERATION_ID}-0`],
      ).map(({ kind }) => kind),
    ).toEqual(["canary_proof", "canary_deletion"]);
    for (const leaf of [
      `${OPERATION_ID}.unknown.${TRANSITION_ID}.tmp`,
      `${OPERATION_ID}.json.extra`,
      `${OPERATION_ID.toUpperCase()}.json`,
      "payload",
    ]) {
      expect(() => parseAtomicPublicationIntentLeaf(leaf)).toThrow();
    }
    expect(() =>
      validateAtomicPublicationWrapperEntries(allocatedIntent(), [
        "payload",
        "payload",
      ]),
    ).toThrow(/duplicate/u);
    expect(() =>
      validateAtomicPublicationWrapperEntries(allocatedIntent(), [
        "payload",
        `delete-${OPERATION_ID}`,
      ]),
    ).toThrow(/incompatible/u);
    expect(() =>
      validateAtomicPublicationWrapperEntries(allocatedIntent(), [
        "payload",
        "unknown",
      ]),
    ).toThrow(/incompatible/u);
    expect(() => parseAtomicPublicationWrapperName("a".repeat(129))).toThrow(
      /leaf/u,
    );
    expect(() => parseAtomicPublicationWrapperName(`.${OPERATION_ID}`)).toThrow(
      /leaf/u,
    );
  });

  it.each(["prepare", "finalize"] as const)(
    "binds %s source generation, checksum, and byte size",
    (kind) => {
      const state = kind === "prepare" ? "staging" : "committed";
      const sourceState = kind === "prepare" ? "working" : "staging";
      const intent: AtomicPublishIntentV1 = {
        ...allocatedIntent(),
        kind,
        phase: "ready",
        target: {
          kind: "profile_state",
          profileId: PROFILE_ID,
          state,
          generationId: GENERATION_ID,
          leaf: GENERATION_ID,
          parent: { dev: "1", ino: "2", mode: 448 },
        },
        wrapper: { dev: "1", ino: "5", mode: 448 },
        privateSource: {
          dev: "1",
          ino: "6",
          mode: 448,
          checksum: SHA_C,
          byteSize: 7,
        },
        publicSource: {
          profileId: PROFILE_ID,
          state: sourceState,
          generationId: GENERATION_ID,
          dev: "1",
          ino: "8",
          mode: 448,
          checksum: SHA_C,
          byteSize: 7,
          capabilityDigest: SHA_B,
        },
      };
      expect(() => encodeAtomicPublishIntent(intent)).not.toThrow();
      expect(() =>
        encodeAtomicPublishIntent({
          ...intent,
          publicSource: {
            ...intent.publicSource!,
            generationId: PROFILE_ID,
          },
        }),
      ).toThrow(/bind/u);
      expect(() =>
        encodeAtomicPublishIntent({
          ...intent,
          privateSource: { ...intent.privateSource!, checksum: SHA_A },
        }),
      ).toThrow(/match/u);
      expect(() =>
        encodeAtomicPublishIntent({
          ...intent,
          privateSource: { ...intent.privateSource!, byteSize: 8 },
        }),
      ).toThrow(/match/u);
    },
  );

  it("rejects negative-zero canary attempt", () => {
    const canary: AtomicPublishIntentV1 = {
      ...allocatedIntent(),
      kind: "canary",
      target: {
        kind: "canary_parent",
        parentLocator: { kind: "profiles" },
        parent: { dev: "1", ino: "2", mode: 448 },
      },
      canaryProof: {
        attempt: -0,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        deletionLeaf: `deletion-${OPERATION_ID}-0`,
        phase: "planned",
        dev: null,
        ino: null,
        mode: null,
        evidenceDigest: null,
      },
    };
    expect(() => encodeAtomicPublishIntent(canary)).toThrow(/attempt/u);
  });

  it("bounds intent and manifest encoders before allocation", () => {
    const building: AtomicPublishIntentV1 = {
      ...allocatedIntent(),
      phase: "building",
      wrapper: { dev: "1", ino: "5", mode: 448 },
    };
    const baseIntentSize = encodeAtomicPublishIntent(building).bytes.byteLength;
    const exactIntentDev = `1${"0".repeat(
      ATOMIC_PUBLISH_INTENT_MAX_BYTES - baseIntentSize,
    )}`;
    expect(
      encodeAtomicPublishIntent({
        ...building,
        wrapper: { ...building.wrapper!, dev: exactIntentDev },
      }).bytes.byteLength,
    ).toBe(ATOMIC_PUBLISH_INTENT_MAX_BYTES);
    expect(() =>
      encodeAtomicPublishIntent({
        ...building,
        wrapper: { ...building.wrapper!, dev: `${exactIntentDev}0` },
      }),
    ).toThrow(/size/u);

    const manifest = cleanupManifest();
    const baseManifestSize =
      encodeCleanupIdentityManifest(manifest).bytes.byteLength;
    const exactManifestDev = `1${"0".repeat(
      CLEANUP_IDENTITY_MANIFEST_MAX_BYTES - baseManifestSize,
    )}`;
    expect(
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          { ...manifest.entries[0]!, dev: exactManifestDev },
          manifest.entries[1]!,
        ],
      }).bytes.byteLength,
    ).toBe(CLEANUP_IDENTITY_MANIFEST_MAX_BYTES);
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          { ...manifest.entries[0]!, dev: `${exactManifestDev}0` },
          manifest.entries[1]!,
        ],
      }),
    ).toThrow(/size/u);
  });

  it("accepts exact path, depth, segment, and entry-count maxima", () => {
    const manifest = cleanupManifest();
    const pathAtMaximum = Array.from({ length: 5 }, () => "x".repeat(204)).join(
      "/",
    );
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, path: pathAtMaximum }],
      }),
    ).not.toThrow();
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, path: "x".repeat(255) }],
      }),
    ).not.toThrow();
    expect(() =>
      encodeCleanupIdentityManifest({
        ...manifest,
        entries: [
          {
            ...manifest.entries[0]!,
            path: Array.from({ length: 64 }, () => "x").join("/"),
          },
        ],
      }),
    ).not.toThrow();
    const entries = Array.from(
      { length: CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES },
      (_, index) => ({
        ...manifest.entries[0]!,
        index,
        path: `x-${index.toString().padStart(5, "0")}`,
      }),
    );
    expect(
      encodeCleanupIdentityManifest({ ...manifest, entries }).entryCount,
    ).toBe(CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES);
  });

  it("persists removed source and discarding done in separate transitions", () => {
    const removing = sourceDeletingIntent();
    const removed: AtomicPublishIntentV1 = {
      ...removing,
      sourceDeletion: {
        ...removing.sourceDeletion!,
        phase: "removed",
        nextIndex: 0,
      },
    };
    const adopted: AtomicPublishIntentV1 = {
      ...removed,
      phase: "adopted",
      adoption: {
        authority: "prepare_token",
        authorityDigest: SHA_C,
      },
    };
    expect(() =>
      validateAtomicPublishIntentTransition(removing, adopted),
    ).toThrow(/transition/u);
    expect(validateAtomicPublishIntentTransition(removing, removed)).toEqual(
      removed,
    );
    expect(validateAtomicPublishIntentTransition(removed, adopted)).toEqual(
      adopted,
    );

    const discarding = discardingIntent();
    const intentTemps: AtomicPublishIntentV1 = {
      ...discarding,
      cleanup: {
        ...discarding.cleanup!,
        suffix: "intent_temps",
        nextIndex: 2,
      },
    };
    const done: AtomicPublishIntentV1 = {
      ...intentTemps,
      cleanup: { ...intentTemps.cleanup!, suffix: "done", nextIndex: 0 },
    };
    const manifestDeleting: AtomicPublishIntentV1 = {
      ...done,
      phase: "manifest_deleting",
      identityManifest: {
        ...done.identityManifest!,
        phase: "deleting",
      },
      cleanup: { ...done.cleanup!, phase: "cleaned" },
    };
    expect(() =>
      validateAtomicPublishIntentTransition(intentTemps, manifestDeleting),
    ).toThrow(/transition/u);
    expect(validateAtomicPublishIntentTransition(intentTemps, done)).toEqual(
      done,
    );
    expect(
      validateAtomicPublishIntentTransition(done, manifestDeleting),
    ).toEqual(manifestDeleting);
  });

  it.each(["discarding", "manifest_deleting", "cleaned"] as const)(
    "requires removed prepare/finalize source in %s",
    (phase) => {
      const removed = {
        ...sourceDeletingIntent(),
        sourceDeletion: {
          ...sourceDeletingIntent().sourceDeletion!,
          phase: "removed" as const,
          nextIndex: 0,
        },
      };
      const terminal: AtomicPublishIntentV1 =
        phase === "discarding"
          ? {
              ...removed,
              phase,
              cleanup: {
                phase: "discarding",
                outcome: "released_to_reconciliation",
                evidenceDigest: SHA_A,
                suffix: "private_source_entries",
                nextIndex: 0,
              },
            }
          : {
              ...removed,
              phase,
              identityManifest: {
                ...removed.identityManifest!,
                phase: "deleting",
              },
              cleanup: {
                phase: "cleaned",
                outcome: "released_to_reconciliation",
                evidenceDigest: SHA_A,
                suffix: "done",
                nextIndex: 0,
              },
            };
      expect(() => encodeAtomicPublishIntent(terminal)).not.toThrow();
      expect(() =>
        encodeAtomicPublishIntent({ ...terminal, sourceDeletion: null }),
      ).toThrow(/sourceDeletion/u);
    },
  );

  it("supports adopted ownership cleanup and stale-adopted release", () => {
    const { intent } = manifestPlannedBinding();
    const adopted: AtomicPublishIntentV1 = {
      ...intent,
      phase: "adopted",
      identityManifest: {
        ...intent.identityManifest!,
        phase: "published",
        dev: "1",
        ino: "7",
        mode: 384,
      },
      adoption: { authority: "registry", authorityDigest: SHA_C },
    };
    for (const outcome of ["adopted", "released_to_reconciliation"] as const) {
      const discarding: AtomicPublishIntentV1 = {
        ...adopted,
        phase: "discarding",
        cleanup: {
          phase: "discarding",
          outcome,
          evidenceDigest: SHA_A,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      };
      expect(
        validateAtomicPublishIntentTransition(adopted, discarding),
      ).toEqual(discarding);
    }
  });
});
