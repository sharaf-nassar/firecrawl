import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURRENT_STATE_ROOT,
  EXIT_INVALID,
  EXIT_SAFE,
  EXIT_UNRESOLVED,
  checkAtomicPublicationRollback,
  validateReservedDirectoryMetadata,
} from "./check-atomic-publication-rollback.mjs";

const checker = fileURLToPath(
  new URL("./check-atomic-publication-rollback.mjs", import.meta.url),
);
const operationId = "11111111-1111-4111-8111-111111111111";
const transitionId = "22222222-2222-4222-8222-222222222222";
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
];

function createLayout() {
  const parent = mkdtempSync(join(tmpdir(), "firecrawl-rollback-"));
  const state = join(parent, "state");
  const staging = join(state, ".profile-publish-staging");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(join(state, "profiles"), { mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  mkdirSync(join(staging, "bundles"), { mode: 0o700 });
  mkdirSync(join(staging, "intents"), { mode: 0o700 });
  return {
    parent,
    state,
    staging,
    bundles: join(staging, "bundles"),
    intents: join(staging, "intents"),
  };
}

function runChecker(args) {
  return spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8",
    env: {},
  });
}

function expectCategory(result, status, category) {
  assert.equal(result.status, status);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${category}\n`);
}

function expectResult(result, exitCode, category) {
  assert.deepEqual(result, { exitCode, category });
}

function validIntent(kind = "working", phase = "allocated") {
  return canonical(productionIntent(kind, phase));
}

function validManifest() {
  return canonical(productionManifest());
}

const sha = "a".repeat(64);
const token = "A".repeat(43);
const profileId = "33333333-3333-4333-8333-333333333333";
const generationId = "44444444-4444-4444-8444-444444444444";
const binding = {
  processNonce: token,
  controlGenerationNonce: token,
  snapshotDigest: sha,
};
const parentEvidence = { dev: "1", ino: "2", mode: 448 };
const wrapperEvidence = { dev: "1", ino: "3", mode: 448 };
const privateEvidence = {
  dev: "1",
  ino: "4",
  mode: 448,
  checksum: sha,
  byteSize: 0,
};

function canonical(value) {
  return `${JSON.stringify(value)}\n`;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetFor(kind) {
  if (kind === "canary") {
    return {
      kind: "canary_parent",
      parentLocator: { kind: "profiles" },
      parent: parentEvidence,
    };
  }
  if (kind === "scaffold") {
    return {
      kind: "profile",
      profileId,
      leaf: profileId,
      parent: parentEvidence,
    };
  }
  return {
    kind: "profile_state",
    profileId,
    state:
      kind === "working"
        ? "working"
        : kind === "prepare"
          ? "staging"
          : "committed",
    generationId,
    leaf: generationId,
    parent: parentEvidence,
  };
}

function publicSourceFor(kind) {
  if (kind !== "prepare" && kind !== "finalize") return null;
  return {
    profileId,
    state: kind === "prepare" ? "working" : "staging",
    generationId,
    dev: "1",
    ino: "5",
    mode: 448,
    checksum: sha,
    byteSize: 0,
    capabilityDigest: sha,
  };
}

function classificationPublished() {
  return {
    outcome: "published",
    nativeCode: "success",
    sourceMatches: false,
    targetMatches: true,
    targetOther: false,
    evidenceDigest: sha,
  };
}

function manifestEvidence(phase) {
  return {
    phase,
    filename: `${operationId}.identities.json`,
    tempFilename: `${operationId}.identities.${transitionId}.tmp`,
    sha256: sha,
    entryCount: 1,
    byteSize: 1,
    dev: phase === "planned" ? null : "1",
    ino: phase === "planned" ? null : "6",
    mode: phase === "planned" ? null : 384,
  };
}

function cleanupRecord(phase, outcome, suffix) {
  return {
    phase,
    outcome,
    evidenceDigest: sha,
    suffix,
    nextIndex: 0,
  };
}

function productionIntent(kind, phase, overrides = {}) {
  const value = {
    version: 1,
    operationId,
    kind,
    phase,
    binding,
    target: targetFor(kind),
    wrapper: null,
    privateSource: null,
    publicSource: publicSourceFor(kind),
    classification: null,
    sourceDeletion: null,
    adoption: null,
    cleanup: null,
    canaryProof:
      kind === "canary"
        ? {
            attempt: 0,
            sourceLeaf: `proof-${operationId}-0`,
            targetLeaf: `canary-${operationId}-0`,
            deletionLeaf: `deletion-${operationId}-0`,
            phase: "planned",
            dev: null,
            ino: null,
            mode: null,
            evidenceDigest: null,
          }
        : null,
    prepublicationAbort: null,
    identityManifest: null,
  };
  if (phase === "building") {
    value.wrapper = wrapperEvidence;
  } else if (phase === "aborting_prepublication") {
    value.prepublicationAbort = {
      outcome: "never_attempted",
      from: "allocated",
      evidenceDigest: sha,
    };
    value.cleanup = cleanupRecord(
      "aborting_prepublication",
      "never_attempted",
      "private_source_entries",
    );
  } else if (phase !== "allocated") {
    value.wrapper = wrapperEvidence;
    value.privateSource = privateEvidence;
  }
  if (
    [
      "classified",
      "renamed",
      "manifest_planned",
      "manifest_published",
      "source_deleting",
      "adopted",
      "discarding",
      "manifest_deleting",
      "cleaned",
    ].includes(phase)
  ) {
    value.classification = classificationPublished();
  }
  if (kind === "canary" && value.classification !== null) {
    const proofPhase =
      phase === "manifest_deleting" || phase === "cleaned"
        ? "cleaned"
        : phase === "discarding"
          ? "deleting"
          : "published";
    value.canaryProof = {
      ...value.canaryProof,
      phase: proofPhase,
      dev: "1",
      ino: "7",
      mode: 448,
      evidenceDigest: sha,
    };
  }
  if (phase === "manifest_planned") {
    value.identityManifest = manifestEvidence("planned");
  }
  if (
    ["manifest_published", "source_deleting", "adopted", "discarding"].includes(
      phase,
    )
  ) {
    value.identityManifest = manifestEvidence("published");
  }
  if (phase === "source_deleting") {
    value.sourceDeletion = {
      phase: "pending",
      privateDeletionLeaf: `delete-${operationId}`,
      evidenceDigest: sha,
      entryCount: 1,
      nextIndex: 0,
    };
  }
  if (phase === "adopted") {
    value.adoption = {
      authority:
        kind === "scaffold"
          ? "scaffold"
          : kind === "working"
            ? "registry"
            : "reconciliation_snapshot",
      authorityDigest: sha,
    };
  }
  if (
    (kind === "prepare" || kind === "finalize") &&
    ["adopted", "discarding", "manifest_deleting", "cleaned"].includes(
      phase,
    )
  ) {
    value.sourceDeletion = {
      phase: "removed",
      privateDeletionLeaf: `delete-${operationId}`,
      evidenceDigest: sha,
      entryCount: 1,
      nextIndex: 0,
    };
  }
  if (phase === "discarding") {
    value.cleanup = cleanupRecord(
      "discarding",
      kind === "canary"
        ? "canary_complete"
        : "released_to_reconciliation",
      "private_source_entries",
    );
  }
  if (phase === "manifest_deleting" || phase === "cleaned") {
    value.identityManifest = manifestEvidence("deleting");
    value.cleanup = cleanupRecord(
      "cleaned",
      kind === "canary"
        ? "canary_complete"
        : "released_to_reconciliation",
      "done",
    );
  }
  return Object.assign(value, overrides);
}

function productionManifest() {
  return {
    version: 1,
    operationId,
    binding,
    targetLocatorDigest: digest(canonical(targetFor("working"))),
    entries: [
      {
        index: 0,
        scope: "private_profile_payload",
        path: "payload/file",
        type: "file",
        dev: "1",
        ino: "5",
        mode: 384,
        size: 3,
        contentSha256: sha,
      },
      {
        index: 1,
        scope: "private_profile_payload",
        path: "payload",
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

function snapshot(path) {
  const entries = [];
  const visit = relative => {
    const absolute = relative === "" ? path : join(path, relative);
    const stat = lstatSync(absolute, { bigint: true });
    entries.push({
      relative,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: Number(stat.mode & 0o777n),
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      size: String(stat.size),
      type: stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other",
      bytes: stat.isFile() ? readFileSync(absolute, "hex") : null,
    });
    if (stat.isDirectory()) {
      for (const leaf of readdirSync(absolute).sort()) {
        visit(relative === "" ? leaf : join(relative, leaf));
      }
    }
  };
  visit("");
  return entries;
}

test("accepts only one canonical absolute child state-root argument", () => {
  const fixture = createLayout();
  try {
    expectCategory(runChecker([]), EXIT_INVALID, "rollback_invocation_invalid");
    expectCategory(
      runChecker([fixture.state, fixture.state]),
      EXIT_INVALID,
      "rollback_invocation_invalid",
    );
    expectCategory(
      runChecker(["--force", fixture.state]),
      EXIT_INVALID,
      "rollback_invocation_invalid",
    );
    expectCategory(
      runChecker([dirname(fixture.state)]),
      EXIT_INVALID,
      "rollback_invocation_invalid",
    );
    expectCategory(
      runChecker([`${fixture.state}/`]),
      EXIT_INVALID,
      "rollback_invocation_invalid",
    );
    expectCategory(
      runChecker([`${fixture.state}/../${basename(fixture.state)}`]),
      EXIT_INVALID,
      "rollback_invocation_invalid",
    );
    expectCategory(
      runChecker([fixture.state]),
      EXIT_INVALID,
      "rollback_invocation_invalid",
    );
    assert.equal(
      CURRENT_STATE_ROOT,
      "/var/lib/firecrawl-browser-volume/state",
    );
    const exact = runChecker([CURRENT_STATE_ROOT]);
    assert.ok(
      [EXIT_SAFE, EXIT_UNRESOLVED, EXIT_INVALID].includes(exact.status),
    );
    assert.equal(exact.stdout, "");
    assert.ok(
      [
        "rollback_safe\n",
        "rollback_state_unresolved\n",
        "rollback_layout_invalid\n",
      ].includes(exact.stderr),
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("returns safe only for the exact empty held reserved layout", () => {
  const fixture = createLayout();
  try {
    const before = snapshot(fixture.state);
    expectResult(
      checkAtomicPublicationRollback(fixture.state),
      EXIT_SAFE,
      "rollback_safe",
    );
    assert.deepEqual(snapshot(fixture.state), before);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("does not treat any missing reserved subtree as complete proof", () => {
  for (const relative of [
    "profiles",
    ".profile-publish-staging",
    ".profile-publish-staging/bundles",
    ".profile-publish-staging/intents",
  ]) {
    const fixture = createLayout();
    try {
      rmSync(join(fixture.state, relative), { recursive: true });
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("rejects wrong modes, wrong types, symlinks, and unknown layout state", () => {
  const cases = [
    fixture => chmodSync(fixture.state, 0o755),
    fixture => chmodSync(join(fixture.state, "profiles"), 0o755),
    fixture => chmodSync(fixture.staging, 0o755),
    fixture => chmodSync(fixture.bundles, 0o755),
    fixture => chmodSync(fixture.intents, 0o755),
    fixture => {
      rmSync(fixture.intents, { recursive: true });
      writeFileSync(fixture.intents, "", { mode: 0o600 });
    },
    fixture => {
      rmSync(fixture.bundles, { recursive: true });
      symlinkSync(fixture.intents, fixture.bundles);
    },
    fixture => mkdirSync(join(fixture.staging, "unknown"), { mode: 0o700 }),
    fixture => mkdirSync(join(fixture.state, "unknown"), { mode: 0o700 }),
  ];

  for (const mutate of cases) {
    const fixture = createLayout();
    try {
      mutate(fixture);
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("accepts serializer-faithful full intents for every phase and kind", () => {
  const kinds = [
    "canary",
    "scaffold",
    "working",
    "prepare",
    "finalize",
  ];
  const fixtures = kinds.flatMap(kind =>
    phases
      .filter(
        phase =>
          (phase !== "source_deleting" ||
            kind === "prepare" ||
            kind === "finalize") &&
          !(phase === "adopted" && kind === "canary"),
      )
      .map(phase => [
        `${kind}-${phase}`,
        productionIntent(kind, phase),
      ]),
  );

  for (const [label, intent] of fixtures) {
    const fixture = createLayout();
    try {
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        canonical(intent),
        { mode: 0o600 },
      );
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_UNRESOLVED,
        "rollback_state_unresolved",
      );
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("accepts a serializer-faithful bound cleanup manifest", () => {
  const fixture = createLayout();
  try {
    const manifest = productionManifest();
    const manifestBytes = canonical(manifest);
    const intent = productionIntent("working", "manifest_published");
    intent.identityManifest = {
      ...intent.identityManifest,
      sha256: digest(manifestBytes),
      entryCount: manifest.entries.length,
      byteSize: Buffer.byteLength(manifestBytes),
    };
    writeFileSync(
      join(fixture.intents, `${operationId}.json`),
      canonical(intent),
      { mode: 0o600 },
    );
    writeFileSync(
      join(fixture.intents, `${operationId}.identities.json`),
      manifestBytes,
      { mode: 0o600 },
    );
    expectResult(
      checkAtomicPublicationRollback(fixture.state),
      EXIT_UNRESOLVED,
      "rollback_state_unresolved",
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("rejects noncanonical or abbreviated durable JSON bytes", () => {
  const full = productionIntent("working", "allocated");
  const malformed = [
    JSON.stringify(full),
    `${canonical(full)}\n`,
    `${JSON.stringify(full, null, 2)}\n`,
    canonical({ ...full, extra: true }),
    canonical({
      version: 1,
      operationId,
      kind: "working",
      phase: "allocated",
    }),
    canonical({
      ...full,
      binding: {
        processNonce: token,
        snapshotDigest: sha,
      },
    }),
    canonical({
      ...full,
      binding: {
        ...binding,
        extra: true,
      },
    }),
    canonical({
      ...full,
      kind: "scaffold",
    }),
    canonical({
      ...full,
      wrapper: wrapperEvidence,
    }),
  ];
  for (const bytes of malformed) {
    const fixture = createLayout();
    try {
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        bytes,
        { mode: 0o600 },
      );
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("rejects manifest omissions, extras, and durable binding drift", () => {
  const mutations = [
    manifest => {
      const { targetLocatorDigest: omitted, ...rest } = manifest;
      void omitted;
      return rest;
    },
    manifest => ({ ...manifest, extra: true }),
    manifest => ({
      ...manifest,
      entries: manifest.entries.map((entry, index) =>
        index === 0 ? { ...entry, size: -1 } : entry,
      ),
    }),
    manifest => ({
      ...manifest,
      entries: [...manifest.entries].reverse(),
    }),
    manifest => ({
      ...manifest,
      binding: {
        ...manifest.binding,
        snapshotDigest: "b".repeat(64),
      },
    }),
    manifest => ({
      ...manifest,
      targetLocatorDigest: "b".repeat(64),
    }),
  ];

  for (const mutate of mutations) {
    const fixture = createLayout();
    try {
      const manifest = mutate(productionManifest());
      const manifestBytes = canonical(manifest);
      const intent = productionIntent("working", "manifest_published");
      intent.identityManifest = {
        ...intent.identityManifest,
        sha256: digest(manifestBytes),
        entryCount: manifest.entries?.length ?? 0,
        byteSize: Buffer.byteLength(manifestBytes),
      };
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        canonical(intent),
        { mode: 0o600 },
      );
      writeFileSync(
        join(fixture.intents, `${operationId}.identities.json`),
        manifestBytes,
        { mode: 0o600 },
      );
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("blocks every stable and temporary intent/manifest grammar entry", () => {
  const entries = [
    {
      leaf: `${operationId}.json`,
      bytes: canonical(productionIntent("working", "allocated")),
    },
    ...phases.map(phase => ({
      leaf: `${operationId}.${phase}.${transitionId}.tmp`,
      bytes: canonical(
        productionIntent(
          phase === "source_deleting" ? "prepare" : "working",
          phase,
        ),
      ),
    })),
  ];

  for (const { leaf, bytes } of entries) {
    const fixture = createLayout();
    try {
      writeFileSync(join(fixture.intents, leaf), bytes, { mode: 0o600 });
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_UNRESOLVED,
        "rollback_state_unresolved",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }

  for (const location of ["stable", "temp"]) {
    const fixture = createLayout();
    try {
      const manifest = productionManifest();
      const manifestBytes = validManifest();
      const phase =
        location === "stable" ? "manifest_published" : "manifest_planned";
      const intent = productionIntent("working", phase);
      intent.identityManifest = {
        ...intent.identityManifest,
        sha256: digest(manifestBytes),
        entryCount: manifest.entries.length,
        byteSize: Buffer.byteLength(manifestBytes),
      };
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        canonical(intent),
        { mode: 0o600 },
      );
      writeFileSync(
        join(
          fixture.intents,
          location === "stable"
            ? `${operationId}.identities.json`
            : `${operationId}.identities.${transitionId}.tmp`,
        ),
        manifestBytes,
        { mode: 0o600 },
      );
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_UNRESOLVED,
        "rollback_state_unresolved",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("blocks wrapper, payload, canary, and private deletion state", () => {
  const cases = [
    ["working", "building", null],
    ["working", "ready", "payload"],
    ["canary", "ready", `proof-${operationId}-0`],
    ["prepare", "source_deleting", `delete-${operationId}`],
    ["canary", "ready", `deletion-${operationId}-0`],
  ];

  for (const [kind, phase, leaf] of cases) {
    const fixture = createLayout();
    try {
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        validIntent(kind, phase),
        { mode: 0o600 },
      );
      const wrapper = join(fixture.bundles, operationId);
      mkdirSync(wrapper, { mode: 0o700 });
      if (leaf !== null) mkdirSync(join(wrapper, leaf), { mode: 0o700 });
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_UNRESOLVED,
        "rollback_state_unresolved",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("accepts production-compatible two-leaf wrapper pairs", () => {
  const cases = [
    [
      "prepare",
      ["payload", `delete-${operationId}`],
    ],
    [
      "finalize",
      ["payload", `delete-${operationId}`],
    ],
    [
      "canary",
      [
        `proof-${operationId}-0`,
        `deletion-${operationId}-0`,
      ],
    ],
  ];

  for (const [kind, leaves] of cases) {
    const fixture = createLayout();
    try {
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        validIntent(kind, "ready"),
        { mode: 0o600 },
      );
      const wrapper = join(fixture.bundles, operationId);
      mkdirSync(wrapper, { mode: 0o700 });
      for (const leaf of leaves) {
        mkdirSync(join(wrapper, leaf), { mode: 0o700 });
      }
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_UNRESOLVED,
        "rollback_state_unresolved",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("rejects malformed and unknown reserved entries without exposing names", () => {
  const cases = [
    fixture =>
      writeFileSync(join(fixture.intents, "unknown"), "secret", {
        mode: 0o600,
      }),
    fixture =>
      writeFileSync(join(fixture.intents, `${operationId}.json`), "{}", {
        mode: 0o644,
      }),
    fixture =>
      writeFileSync(join(fixture.intents, `${operationId}.json`), "{}", {
        mode: 0o600,
      }),
    fixture =>
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        JSON.stringify({
          version: 1,
          operationId: transitionId,
          kind: "working",
          phase: "allocated",
        }),
        { mode: 0o600 },
      ),
    fixture => mkdirSync(join(fixture.bundles, "not-a-uuid"), { mode: 0o700 }),
    fixture => {
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        validIntent(),
        { mode: 0o600 },
      );
      const wrapper = join(fixture.bundles, operationId);
      mkdirSync(wrapper, { mode: 0o700 });
      mkdirSync(join(wrapper, "unknown-secret"), { mode: 0o700 });
    },
  ];

  for (const mutate of cases) {
    const fixture = createLayout();
    try {
      mutate(fixture);
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("allows only exact known state-root children", () => {
  const fixture = createLayout();
  try {
    mkdirSync(join(fixture.state, "replay"), { mode: 0o700 });
    mkdirSync(join(fixture.state, "quarantine"), { mode: 0o700 });
    expectResult(
      checkAtomicPublicationRollback(fixture.state),
      EXIT_SAFE,
      "rollback_safe",
    );
    mkdirSync(join(fixture.state, "foreign"), { mode: 0o700 });
    expectResult(
      checkAtomicPublicationRollback(fixture.state),
      EXIT_INVALID,
      "rollback_layout_invalid",
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("validates exact owner, group, mode, type, and device metadata", () => {
  const metadata = overrides => ({
    dev: 7n,
    gid: 1000n,
    mode: 0o40700n,
    nlink: 2n,
    uid: 1000n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  });
  assert.equal(validateReservedDirectoryMetadata(metadata(), 7n), true);
  for (const invalid of [
    metadata({ uid: 1001n }),
    metadata({ gid: 1001n }),
    metadata({ mode: 0o40755n }),
    metadata({ dev: 8n }),
    metadata({ isDirectory: () => false }),
    metadata({ isSymbolicLink: () => true }),
  ]) {
    assert.equal(validateReservedDirectoryMetadata(invalid, 7n), false);
  }
});

test("rejects incompatible publication artifacts and intent kinds", () => {
  const cases = [
    {
      stableKind: "working",
      leaves: ["payload", `proof-${operationId}-0`],
    },
    { stableKind: "canary", leaves: ["payload"] },
    {
      stableKind: "working",
      leaves: [`deletion-${operationId}-0`],
    },
    {
      stableKind: "prepare",
      leaves: [`deletion-${operationId}-0`],
    },
    {
      stableKind: "prepare",
      leaves: ["payload", `delete-${transitionId}`],
    },
    {
      stableKind: "canary",
      leaves: [
        `proof-${operationId}-0`,
        `deletion-${transitionId}-0`,
      ],
    },
  ];

  for (const { stableKind, leaves } of cases) {
    const fixture = createLayout();
    try {
      writeFileSync(
        join(fixture.intents, `${operationId}.json`),
        validIntent(stableKind),
        { mode: 0o600 },
      );
      const wrapper = join(fixture.bundles, operationId);
      mkdirSync(wrapper, { mode: 0o700 });
      for (const leaf of leaves) {
        mkdirSync(join(wrapper, leaf), { mode: 0o700 });
      }
      expectResult(
        checkAtomicPublicationRollback(fixture.state),
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }

  const mismatched = createLayout();
  try {
    writeFileSync(
      join(mismatched.intents, `${operationId}.json`),
      validIntent("working"),
      { mode: 0o600 },
    );
    writeFileSync(
      join(
        mismatched.intents,
        `${operationId}.ready.${transitionId}.tmp`,
      ),
      validIntent("canary", "ready"),
      { mode: 0o600 },
    );
    expectResult(
      checkAtomicPublicationRollback(mismatched.state),
      EXIT_INVALID,
      "rollback_layout_invalid",
    );
  } finally {
    rmSync(mismatched.parent, { recursive: true, force: true });
  }

  const orphanWrapper = createLayout();
  try {
    mkdirSync(join(orphanWrapper.bundles, operationId), { mode: 0o700 });
    expectResult(
      checkAtomicPublicationRollback(orphanWrapper.state),
      EXIT_INVALID,
      "rollback_layout_invalid",
    );
  } finally {
    rmSync(orphanWrapper.parent, { recursive: true, force: true });
  }
});

test("preserves unresolved and invalid bytes without repair or deletion", () => {
  const cases = [
    fixture =>
      writeFileSync(join(fixture.intents, `${operationId}.json`), "durable", {
        mode: 0o600,
      }),
    fixture =>
      writeFileSync(join(fixture.intents, "unknown"), "private-secret", {
        mode: 0o600,
      }),
  ];

  for (const mutate of cases) {
    const fixture = createLayout();
    try {
      mutate(fixture);
      const before = snapshot(fixture.state);
      const result = checkAtomicPublicationRollback(fixture.state);
      assert.ok(
        result.exitCode === EXIT_UNRESOLVED ||
          result.exitCode === EXIT_INVALID,
      );
      assert.deepEqual(snapshot(fixture.state), before);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("detects state-root replacement after acquiring held authorities", () => {
  const fixture = createLayout();
  const replacement = `${fixture.state}-replacement`;
  try {
    const result = checkAtomicPublicationRollback(fixture.state, {
      afterLayoutHeld() {
        renameSync(fixture.state, replacement);
        mkdirSync(fixture.state, { mode: 0o700 });
      },
    });
    assert.deepEqual(result, {
      exitCode: EXIT_INVALID,
      category: "rollback_layout_invalid",
    });
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("detects replacement of every held reserved descendant", () => {
  for (const relative of [
    "profiles",
    ".profile-publish-staging",
    ".profile-publish-staging/bundles",
    ".profile-publish-staging/intents",
  ]) {
    const fixture = createLayout();
    const target = join(fixture.state, relative);
    const replacement = `${target}-replacement`;
    try {
      const result = checkAtomicPublicationRollback(fixture.state, {
        afterLayoutHeld() {
          renameSync(target, replacement);
          mkdirSync(target, { mode: 0o700 });
        },
      });
      expectResult(
        result,
        EXIT_INVALID,
        "rollback_layout_invalid",
      );
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("uses only recorded read-only filesystem operations", () => {
  const fixture = createLayout();
  const calls = [];
  const openFlags = [];
  const allowed = {
    closeSync(...args) {
      calls.push("closeSync");
      return closeSync(...args);
    },
    fstatSync(...args) {
      calls.push("fstatSync");
      return fstatSync(...args);
    },
    lstatSync(...args) {
      calls.push("lstatSync");
      return lstatSync(...args);
    },
    openSync(path, flags, ...rest) {
      calls.push("openSync");
      openFlags.push(flags);
      return openSync(path, flags, ...rest);
    },
    readFileSync(...args) {
      calls.push("readFileSync");
      return readFileSync(...args);
    },
    readdirSync(...args) {
      calls.push("readdirSync");
      return readdirSync(...args);
    },
    realpathSync(...args) {
      calls.push("realpathSync");
      return realpathSync(...args);
    },
  };
  const io = new Proxy(allowed, {
    get(target, property) {
      if (!Object.hasOwn(target, property)) {
        throw new Error(`mutating or unknown operation: ${String(property)}`);
      }
      return target[property];
    },
  });

  try {
    const before = snapshot(fixture.state);
    expectResult(
      checkAtomicPublicationRollback(fixture.state, { io }),
      EXIT_SAFE,
      "rollback_safe",
    );
    assert.ok(calls.length > 0);
    for (const flags of openFlags) {
      assert.equal(
        flags &
          (constants.O_APPEND |
            constants.O_CREAT |
            constants.O_RDWR |
            constants.O_TRUNC |
            constants.O_WRONLY),
        0,
      );
      assert.notEqual(flags & constants.O_NOFOLLOW, 0);
    }
    assert.deepEqual(snapshot(fixture.state), before);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("checker source exposes no mutation, repair, force, or alternate-root path", () => {
  const source = readFileSync(checker, "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:appendFile|chmod|chown|copyFile|createWriteStream|fchmod|fchown|fdatasync|fsync|ftruncate|link|lutimes|mkdir|mkdtemp|openAsBlob|rename|rm|rmdir|symlink|truncate|unlink|utimes|writeFile|writev?)Sync?\b/u,
  );
  assert.doesNotMatch(source, /\bO_(?:APPEND|CREAT|EXCL|RDWR|TRUNC|WRONLY)\b/u);
  assert.doesNotMatch(source, /--force|--repair|--root|process\.env/u);
  assert.match(source, /\bO_NOFOLLOW\b/u);
  assert.match(source, /\bO_RDONLY\b/u);
});
