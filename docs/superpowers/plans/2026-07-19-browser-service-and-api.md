# Local Browser Service and API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private persistent Browser Service and connect the existing
Browser and Interact APIs to it through an API-owned, durable, execute-once
browser-action coordinator.

**Architecture:** Firecrawl API remains the authorization, compatibility, and
durable-state boundary. A private TypeScript Browser Service owns Chromium,
profiles, typed operations, live-view streams, and live action-ID
deduplication. Prompt Interact submits one outer job to the host adapter; the
adapter runs its bounded Codex observe/act loop and calls the API with strict
action proposals, while only the API records, authorizes, and dispatches an
action. A canonical V1 inventory is implemented independently on each side;
Chromium can egress only through one DNS-validating manual proxy with direct
UDP disabled; replay is accepted only after in-place Playwright storage-state
round-trip verification. API owns all local retention, while the harness owns
only fresh disposable runtime/database resources.

**Tech Stack:** Node.js 22.22.1, pnpm 10.33.0, TypeScript 5.9.3,
Express 5.2.1, `ws` 8.21.1, Zod 4.4.3, Playwright 1.61.1/Chromium,
`ipaddr.js` 2.4.0, PostgreSQL-backed API state, Vitest 4.1.9, Node test
runner for bootstrap tests only, Docker Compose.

---

## Scope and prerequisites

Start after the revised Gate/state/replay plan has landed. Consume these exact
contracts:

- approved hardening addendum
  `docs/superpowers/specs/2026-07-21-browser-service-plan-hardening-design.md`;
- `apps/api/src/lib/browser-state/types.ts`
- `apps/api/src/lib/browser-state/transitions.ts`
- `apps/api/src/lib/browser-state/store.ts`
- `apps/api/src/lib/scrape-interact/replay-envelope.ts`
- `apps/api/src/lib/scrape-interact/replay-store.ts`
- migration `apps/api/src/db/migrations/0004_browser_interact_foundation.sql`

That prerequisite must already define `browser_interact_actions` and the
approved action states:

```ts
export type BrowserInteractActionState =
  | "prepared"
  | "executing"
  | "succeeded"
  | "rejected_no_effect"
  | "failed_no_effect"
  | "cancelled_no_effect"
  | "outcome_unknown";
```

Host execution remains a later plan. This plan defines the API boundary that
the host adapter replaces:

```ts
executePromptRun(input, signal): Promise<PromptRunResult>
executeCodeRun(input, signal): Promise<CodeRunResult>
cancelExecutionRun(runId, reason): Promise<void>
```

One `executePromptRun` call represents the complete multi-turn Codex job. The
host adapter owns one app-server process and thread, but it never receives a
Browser Service endpoint, capability token, browser relay, MCP configuration,
or caller-selected model. Each model action returns through the authenticated
API callback defined in Task 10.

The default adapter returns `codex_unavailable` for prompt mode and
`sandbox_unavailable` for code mode. API tests inject a fake adapter. Keep
`LOCAL_BROWSER_SERVICE_ENABLED=false` until Browser Service, API, host, and
operations acceptance plans all pass. Local mode never falls back to Gemini,
Fireworks, Firecrawl Cloud, or an API key.

Before host-execution plan Task 5 runs, revise its stale Codex `0.144.5` pins
to consume approved rolling installed-Codex contract. Keep model
`gpt-5.6-terra`, `medium` effort, schema, capability, safety, and lifecycle
gates pinned; never restore an exact Codex CLI version requirement.

All Browser Service host commands deliberately prepend the already installed
Node `22.22.1` directory:

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node --version
```

Expected: `v22.22.1`. Do not invoke Corepack or pnpm until Task 1 has created
`apps/browser-service/package.json`; only then run Corepack from that package
or with `--dir apps/browser-service` so it reads the committed
`packageManager: "pnpm@10.33.0"`. Do not scan for or install another Node,
change the user's default Node, or run Browser Service commands under active
Node `25.8.2`. Corepack may acquire project-scoped pnpm `10.33.0` during Task
1; that dependency acquisition and the package install are authorized. No
global install is authorized.

Execute directly on current `main`; do not create a worktree or nested copy.
For every numbered task, use one fresh implementation subagent, then a
requirements review and a quality review before advancing. Route findings to
same implementer and repeat both reviews. Stage only task files, run actual
configured repository hook, and make one literal compliant commit whose
subject and every body line are at most 72 characters.

## File map

### Browser Service

- `apps/browser-service/contracts/private-v1.contract.json` — canonical,
  versioned, closed private-route inventory and schema fingerprint source.
- `apps/browser-service/package.json` — standalone scripts and pinned runtime.
- `apps/browser-service/pnpm-lock.yaml` — reproducible dependency graph.
- `apps/browser-service/tsconfig.json` — strict NodeNext compilation.
- `apps/browser-service/src/runtime-preflight.mjs` — dependency-free exact
  Node runtime guard used before install, test, build, and start.
- `apps/browser-service/src/runtime-preflight.test.mjs` — accepted and rejected
  runtime identity coverage.
- `apps/browser-service/src/lockfile.test.mjs` — frozen-lock mutation and
  missing-lock rejection.
- `apps/browser-service/Dockerfile` — private non-root Chromium image.
- `apps/browser-service/src/config.ts` — validated service configuration.
- `apps/browser-service/src/contracts.ts` — strict session, operation, action,
  profile, artifact, grant, and health schemas.
- `apps/browser-service/src/contract-inventory.ts` — service-owned normalized
  V1 inventory and canonical fingerprint.
- `apps/browser-service/src/errors.ts` — typed internal failures and HTTP map.
- `apps/browser-service/src/auth.ts` — service identity, correlation, deadline.
- `apps/browser-service/src/network-policy.ts` — URL/domain/IP normalization.
- `apps/browser-service/src/egress-proxy.ts` — DNS-pinned HTTP/CONNECT proxy.
- `apps/browser-service/src/chromium-launch-policy.ts` — exact manual proxy,
  loopback-bypass subtraction, QUIC, and WebRTC launch policy.
- `apps/browser-service/src/chromium-egress.integration.test.ts` — real bundled
  Chromium TCP/UDP escape proof with positive controls.
- `apps/browser-service/src/profile-store.ts` — working copies and immutable
  atomic profile generations.
- `apps/browser-service/src/startup-state.ts` — process nonce, liveness,
  readiness latch, digest replay rules, and browser-work admission.
- `apps/browser-service/src/reconciliation.ts` — closed snapshot
  canonicalization, authority validation, quarantine cleanup, and retry.
- `apps/browser-service/src/evaluate-policy.ts` — constrained page-expression
  parser and allowlist.
- `apps/browser-service/src/operations.ts` — typed Playwright operation engine.
- `apps/browser-service/src/action-cache.ts` — live action-ID execute-once cache.
- `apps/browser-service/src/session-registry.ts` — Chromium lifecycle, leases,
  origins, TTLs, replay, and close.
- `apps/browser-service/src/replay-restore.ts` — in-place storage-state restore,
  immediate export verification, and discard-on-failure boundary.
- `apps/browser-service/src/streams.ts` — passive, interactive, and CDP streams.
- `apps/browser-service/src/artifacts.ts` — bounded authenticated captures.
- `apps/browser-service/src/server.ts` — authenticated HTTP/WS routes.
- `apps/browser-service/src/index.ts` — startup and ordered shutdown.
- Adjacent `*.test.ts` files — deterministic contract/security coverage.

### Firecrawl API

- `apps/api/src/config.ts` — local feature and private service configuration.
- `apps/api/src/lib/local-runtime-config.ts` — fail-closed local validation.
- `apps/api/src/lib/scrape-interact/browser-service-client.ts` — typed,
  deadline-aware Browser Service client.
- `apps/api/src/lib/scrape-interact/browser-service-contracts.ts` — API-owned
  closed V1 schemas and canonical-inventory fingerprint.
- `apps/api/src/lib/browser-runtime/startup-gate.ts` — fail-closed browser work
  and browser-state mutator/retention gate.
- `apps/api/src/lib/browser-runtime/reconciliation-snapshot.ts` —
  repeatable-read PostgreSQL authority snapshot and canonical digest.
- `apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts` — recovery,
  reconciliation, ready verification, nonce monitoring, and restart coalescing.
- `apps/api/src/lib/browser-runtime/protocol.ts` — strict shared
  internal `BrowserOperation`/`ModelDecisionV1`, distinct
  `ModelWireBrowserOperationV1`/`ModelWireDecisionV1` envelope, explicit
  normalization, and `ObservationV1` schemas.
- `apps/api/src/lib/browser-runtime/execution-adapter.ts` — one-job host adapter
  interface and fail-closed default.
- `apps/api/src/lib/browser-runtime/orchestrator.ts` — durable session, replay,
  profile, adapter-job, and cleanup coordination.
- `apps/api/src/lib/browser-runtime/action-normalization.ts` — canonical action
  serialization, SHA-256, and trusted effect classification.
- `apps/api/src/lib/browser-runtime/action-coordinator.ts` — durable prepare,
  authorize, dispatch-once, callback replay, and terminal ambiguity handling.
- `apps/api/src/lib/browser-state/capability-store.ts` — server-held operation,
  origin, byte, action, and deadline authority.
- `apps/api/src/lib/browser-state/proxy-grant-store.ts` — hashed public grants.
- `apps/api/src/lib/browser-runtime/proxy-urls.ts` — opaque public proxy URLs.
- `apps/api/src/lib/browser-runtime/artifacts.ts` — bounded MinIO ingestion.
- `apps/api/src/lib/artifacts/{manifest,local-manifest}.ts` — optional SHA-256
  for old artifacts, mandatory SHA-256 for browser artifacts.
- `apps/api/src/controllers/internal/browser-runs.ts` — adapter-only action,
  CDP, and artifact callbacks.
- `apps/api/src/routes/internal.ts` — adapter-token authenticated routes.
- `apps/api/src/controllers/v2/browser.ts` — direct Browser compatibility.
- `apps/api/src/controllers/v2/scrape-browser.ts` — local Interact and stop.
- `apps/api/src/controllers/v2/browser-proxy.ts` — viewer and WS relay.
- `apps/api/src/routes/v2.ts` — public proxy routes.
- `apps/api/src/index.ts` — internal callback router.
- Focused adjacent `*.test.ts` files — deterministic API coverage.
- `apps/api/src/__tests__/snips/v2/lib.ts` — Browser/Interact helpers.
- `apps/api/src/__tests__/snips/v2/browser-local.test.ts` — direct API snips.
- `apps/api/src/__tests__/snips/v2/scrape-browser.test.ts` — replay/stop snips.
- `apps/api/src/__tests__/snips/v2/browser-real-codex.test.ts` — post-host real
  Codex action-ledger and zero-tool smoke.
- `apps/api/src/harness-browser-service.ts` — disposable service lifecycle.
- `apps/api/src/harness-browser-service.test.ts` — harness cleanup coverage.
- `apps/api/src/harness.ts` and `apps/api/package.json` — managed snip command.

### Local runtime

- `compose.local.yaml` — private service and shared browser-state volume.
- `.env.example.local` — non-secret disabled rollout configuration.

## Locked private contracts

Every private HTTP request carries
`Authorization: Bearer <service key>`,
`x-firecrawl-correlation-id`, and an ISO `x-firecrawl-deadline`. Unknown JSON
fields fail with 400. Every UUID is canonical lowercase, every SHA-256 is 64
lowercase hex characters, timestamps are canonical UTC ISO strings, URLs are
absolute HTTP(S) strings at most 8,192 characters, relative state paths are
root-confined UTF-8 strings at most 1,024 bytes, opaque tokens/nonces are
unpadded base64url encodings of exactly 32 bytes, and JSON responses reject
unknown fields. Unless stated otherwise, request JSON is at most 256 KiB and
response JSON at most 128 KiB.
Bearer header is at most 4,096 bytes; correlation ID is 1..128 printable ASCII
characters; deadline is canonical UTC, strictly future, and at most 5 minutes
ahead. Every non-stream error is strict
`{version:1,category:string,message:string}` with category 1..128 printable
ASCII characters, sanitized message at most 1,024 characters, and encoded size
at most 4 KiB.
Every `:runtimeSessionId`, `:grantId`, and `:generationId` route parameter is
an `Id`; a body field repeating a route ID must equal it.

The single source of contract truth is the checked-in, canonical JSON fixture
`apps/browser-service/contracts/private-v1.contract.json`. It has exactly the
top-level members `version:1`, `routes`, and `definitions`; fingerprint input
uses recursively sorted object keys and no insignificant whitespace,
and the following route inventory. Each route record locks method, path,
request definition or `null`, success status, response definition, request
byte cap, response byte cap, and streaming metadata. No endpoint may be added
to either implementation without changing this fixture.

```text
POST   /v1/sessions                                      CreateSessionV1 -> 201 SessionV1
GET    /v1/sessions/:runtimeSessionId                    null -> 200 SessionV1
DELETE /v1/sessions/:runtimeSessionId                    CloseSessionV1 -> 200 ClosedSessionV1
POST   /v1/sessions/:runtimeSessionId/actions            BrowserActionExecutionV1 -> 200 BrowserActionExecutionResultV1
POST   /v1/sessions/:runtimeSessionId/grants             CreateRelayGrantV1 -> 201 RelayGrantV1
DELETE /v1/sessions/:runtimeSessionId/grants/:grantId    RevokeRelayGrantV1 -> 200 RevokedRelayGrantV1
POST   /v1/sessions/:runtimeSessionId/artifacts          FetchArtifactV1 -> 200 binary + ArtifactMetadataV1 headers
POST   /v1/profile-generations/:generationId/finalize    FinalizeProfileGenerationV1 -> 200 FinalizedProfileGenerationV1
DELETE /v1/profile-generations/:generationId             DeleteProfileGenerationV1 -> 200 DeletedProfileGenerationV1
POST   /v1/reconciliation                                ReconciliationRequestV1 -> 200 ReconciliationResultV1
WS     /v1/sessions/:runtimeSessionId/streams/passive
WS     /v1/sessions/:runtimeSessionId/streams/interactive
WS     /v1/sessions/:runtimeSessionId/streams/cdp
GET    /health/live                                      null -> 200 LiveHealthV1
GET    /health/ready                                     null -> 200 ReadyHealthV1 | 503 UnreadyHealthV1
```

The fixture definitions lock these exact closed shapes and bounds:

```ts
type Id = string;              // canonical lowercase UUID
type Sha256 = string;          // /^[a-f0-9]{64}$/
type Token = string;           // 43-char canonical base64url, 32 decoded bytes
type HttpUrl = string;         // absolute HTTP(S), 1..8_192 chars
type Timestamp = string;       // canonical UTC ISO-8601
type RelativeStatePath = string; // root-relative, 1..1_024 UTF-8 bytes

type JsonSafe =
  | null | boolean | number | string
  | JsonSafe[] | { [key: string]: JsonSafe };
// finite numbers only; depth <= 16; arrays <= 1_000 entries; objects <= 256
// own enumerable keys; each key <= 256 chars; each string <= 64 KiB; no
// cycles, sparse arrays, accessors, prototypes other than Object/null, symbol
// keys, undefined, symbol, function, bigint, NaN, or infinities.

type StorageStateV1 = {
  cookies: Array<{ // <= 10_000
    name: string;                 // 1..4_096
    value: string;                // <= 65_536
    domain: string;               // 1..4_096
    path: string;                 // 1..4_096
    expires: number;              // finite
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    partitionKey?: string;        // 1..4_096
    _crHasCrossSiteAncestor?: boolean;
  }>;
  origins: Array<{               // <= 256
    origin: HttpUrl;
    localStorage: Array<{        // <= 10_000 per origin
      name: string;              // <= 4_096
      value: string;             // <= 65_536
    }>;
    indexedDB?: Array<{          // <= 256 per origin
      name: string;              // 1..4_096
      version: number;           // positive safe integer
      stores: Array<{            // <= 256 per database
        name: string;            // 1..4_096
        autoIncrement: boolean;
        keyPath?: string;        // <= 4_096; XOR keyPathArray
        keyPathArray?: string[]; // <= 64, each <= 4_096
        records: Array<{         // <= 10_000 per store
          key?: JsonSafe; keyEncoded?: JsonSafe; // XOR when out-of-line
          value?: JsonSafe; valueEncoded?: JsonSafe; // exactly one
        }>;
        indexes: Array<{         // <= 256 per store
          name: string;          // 1..4_096
          keyPath?: string;      // XOR keyPathArray
          keyPathArray?: string[]; // <= 64, each <= 4_096
          multiEntry: boolean;
          unique: boolean;
        }>;
      }>;
    }>;
  }>;
}; // canonical encoded StorageStateV1 <= 16 MiB

type ReplayBrowserSettingsV1 = {
  headers: Record<string, string>; // <= 256 valid HTTP fields, <= 64 KiB total
  cookies: StorageStateV1["cookies"];
  viewport: {
    width: number; height: number; // integers 1..7_680 / 1..4_320
    deviceScaleFactor: number;     // finite > 0 and <= 10
    isMobile: boolean; hasTouch: boolean;
  };
  deviceName?: string;             // 1..256
  userAgent: string;               // 1..4_096
  locale: string;                  // valid language tag, 1..128
  timezoneId?: string;             // valid IANA zone, 1..256
  geolocation?: {
    latitude: number;              // finite -90..90
    longitude: number;             // finite -180..180
    accuracy: number;              // finite >= 0 and <= 100_000
  };
  location: {
    country: string;               // supported value, 1..64
    languages: string[];           // <= 32 valid tags, each 1..128
  };
  proxy: {
    kind: "basic" | "stealth" | "enhanced" | "auto";
    country?: string;              // supported value, 1..64
    credentialRef?: string;        // /^proxy-credential:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
  };
  skipTlsVerification: boolean; blockAds: boolean; lockdown: boolean;
};

type ReplayCheckpointV1 = {
  checkpointId: Id;
  statePath: RelativeStatePath;
  checksum: Sha256;
  byteSize: number;                // safe integer 1..16_777_216
  storageState: StorageStateV1;
  finalUrl: HttpUrl;
  fingerprint: {
    finalUrl: HttpUrl;             // must equal finalUrl
    titleSha256: Sha256;
    bodyTextSha256: Sha256;
  };
};

type ProfileInputV1 = null | {
  profileId: Id;
  mode: "writer" | "snapshot";
  generationId: Id | null;
  statePath: RelativeStatePath | null;
  checksum: Sha256 | null;
}; // generationId/statePath/checksum are all null or all non-null

type CreateSessionV1 = {
  version: 1;
  sessionId: Id;
  initialUrl: HttpUrl;
  allowedDomains: string[];        // <= 8 unique ASCII hostnames, each <= 253
  ttlSeconds: number;              // integer 30..3_600
  activityTtlSeconds: number;      // integer 10..600 and <= ttlSeconds
  profile: ProfileInputV1;
  replay: ReplayCheckpointV1 | null;
  settings: ReplayBrowserSettingsV1;
}; // <= 16 MiB only when replay is non-null, otherwise <= 256 KiB
// replay != null forbids profile with non-null generationId.

type BoundedPageState = {
  url: HttpUrl;
  title: string;                   // <= 4_096
  snapshotExcerpt: string;         // <= 40_000
};
type SessionV1 = {
  version: 1;
  runtimeSessionId: Id;
  state: "ready" | "executing" | "stopping";
  sessionVersion: number;          // safe integer >= 0
  page: BoundedPageState;
  expiresAt: Timestamp;
  idleExpiresAt: Timestamp;
};
type CloseSessionV1 = {
  version: 1;
  reason: "requested" | "expired" | "error" | "shutdown";
  expectedSessionVersion: number;  // safe integer >= 0
};
type PreparedProfileV1 = {
  profileId: Id; generationId: Id; checksum: Sha256;
  byteSize: number;                // safe integer 1..268_435_456
  prepareToken: Token;
};
type ClosedSessionV1 = {
  version: 1; runtimeSessionId: Id; closed: true;
  sessionVersion: number;          // safe integer >= 0
  preparedProfile: PreparedProfileV1 | null;
};
```

The action request remains the closed 12-operation union from Task 1. Its
result is no longer `unknown`; it is a strict discriminated union:

```ts
type BrowserOperationResultV1 =
  | { kind: "snapshot"; refCount: number }              // integer 0..500
  | { kind: "click" | "fill" | "type" | "press" |
      "select" | "scroll" | "navigate"; applied: true }
  | { kind: "wait"; waitedMs: number }                  // integer 0..30_000
  | { kind: "get_text"; text: string }                  // <= 40_000
  | { kind: "get_url"; url: HttpUrl }
  | { kind: "evaluate"; value: JsonSafe };              // value <= 32 KiB

type BrowserActionExecutionV1 = {
  version: 1; actionId: Id; runId: Id; sequence: number; // sequence 1..25
  normalizedProposalHash: Sha256;
  effect: "read_only" | "side_effecting";
  expectedSessionVersion: number;                        // safe integer >= 0
  operation: BrowserOperation;
}; // operation <= 64 KiB
type BrowserActionExecutionResultV1 =
  | { version: 1; actionId: Id; sequence: number;
      normalizedProposalHash: Sha256; outcome: "succeeded";
      result: BrowserOperationResultV1; page: BoundedPageState;
      sessionVersion: number } // sequence 1..25; version safe integer >=0
  | { version: 1; actionId: Id; sequence: number;
      normalizedProposalHash: Sha256; outcome: "failed_no_effect";
      error: { category: string; message: string }; // 1..128 / <=1_024
      page: BoundedPageState; sessionVersion: number }; // same bounds
// Per-operation encoded result <= 64 KiB; complete action response <=128 KiB.
```

The remaining request/result contracts are exactly:

```ts
type FinalizeProfileGenerationV1 = {
  version: 1; profileId: Id; generationId: Id;
  checksum: Sha256; prepareToken: Token;
};
type FinalizedProfileGenerationV1 = {
  version: 1; profileId: Id; generationId: Id;
  checksum: Sha256; committed: true;
};
type DeleteProfileGenerationV1 = FinalizeProfileGenerationV1;
type DeletedProfileGenerationV1 = {
  version: 1; profileId: Id; generationId: Id;
  checksum: Sha256; deleted: true;
};
type CreateRelayGrantV1 = {
  version: 1; grantId: Id;
  permission: "passive" | "interactive" | "cdp";
  expiresAt: Timestamp; useLimit: 1;
};
type RelayGrantV1 = {
  version: 1; grantId: Id; permission: CreateRelayGrantV1["permission"];
  expiresAt: Timestamp; relayToken: Token;
};
type RevokeRelayGrantV1 = { version: 1; grantId: Id };
type RevokedRelayGrantV1 = { version: 1; grantId: Id; revoked: true };
type FetchArtifactV1 =
  | { version: 1; artifactId: Id; kind: "screenshot";
      format: "png" | "jpeg"; fullPage: boolean }
  | { version: 1; artifactId: Id; kind: "trace" | "recording";
      preset: "diagnostic-v1" };
type ArtifactMetadataV1 = {
  version: 1; artifactId: Id;
  kind: "screenshot" | "trace" | "recording";
  contentType: "image/png" | "image/jpeg" | "application/zip" |
    "video/webm";
  byteSize: number;                // safe integer 1..16_777_216
  checksum: Sha256;
};
```

Artifact fetch returns bytes, not JSON. Its five metadata values are carried
in `x-firecrawl-artifact-version`, `-id`, `-kind`, `-byte-size`, and
`-sha256`; `content-type` carries the locked media type, `content-length`
must equal byte size, and streamed bytes must hash to the metadata checksum.
The service rejects a ninth run artifact or aggregate bytes over 32 MiB.

Health and reconciliation are private too. Before reconciliation,
`GET /health/live` returns strict
`{ version: 1, status: "live_unreconciled", processNonce }`; ready returns 503
with strict `{ version: 1, status: "unready", processNonce, category }`.
After one successful snapshot, ready returns strict
`{ version: 1, status: "ready", processNonce, snapshotDigest }`.
Ordered shutdown closes listener before draining work, so no new live or ready
health response is served. Already accepted requests fail admission through
`requireReady()` once shutdown starts.
`processNonce` is one unpadded base64url encoding of 32 cryptographically
random bytes and is never persisted or logged.

`POST /v1/reconciliation` accepts the exact closed request and result types:

```ts
export type ReconciliationReferenceV1 = {
  kind:
    | "replay_checkpoint"
    | "profile_generation"
    | "replay_checkpoint_cleanup_intent";
  id: Id;
  path: RelativeStatePath;
  checksum: Sha256;
};

export type ReconciliationRequestV1 = {
  version: 1;
  processNonce: Token;
  snapshotDigest: Sha256;
  references: ReconciliationReferenceV1[];
};

export type ReconciliationResultV1 = {
  version: 1;
  processNonce: Token;
  snapshotDigest: Sha256;
  retained: number;
  removed: number;
  missing: 0;
  corrupt: 0;
  ready: true;
};
```

API sorts references by `kind`, `id`, and `path`, serializes fixed-key,
whitespace-free `{version,references}` JSON, and hashes its UTF-8 bytes.
Browser Service independently repeats canonicalization. Each list is capped
at 25,000 entries and request JSON at 16 MiB. Same nonce/digest retry returns
cached success; another digest for that nonce fails
`reconciliation_conflicting_replay`. Any stale nonce fails
`reconciliation_nonce_mismatch` before filesystem access.

`retained` and `removed` are integers 0..25,000. The request holds at most
25,000 references and 16 MiB; its response is at most 4 KiB. Health responses
are at most 4 KiB. Health `category` is exactly
`reconciliation_required | reconciliation_in_progress`; all process nonces
and digests use `Token`/`Sha256` above.

Only API calls these endpoints. `runtimeSessionId` and Browser Service relay
grants are never public. Browser Service returns `failed_no_effect` only when
it proves no page/browser effect occurred. Evaluate runs inside the page and
may mutate before its value is inspected. Therefore cyclic, unsupported, or
oversized evaluate output, serialization failure, timeout, Chromium crash, or
transport loss after dispatch is terminal ambiguity: Browser Service closes
the session and transport without a cache entry; API records
`outcome_unknown`. It must never return `failed_no_effect` for that path.

Task 1 implements Browser Service schemas without importing API code, exports
their normalized inventory and SHA-256 fingerprint, and compares both to the
canonical fixture. Task 7 implements API schemas without importing Browser
Service code and performs the same comparison. This prevents shared-code tests
from hiding drift while making any field, type, bound, status, header, or
route change fail independently in both packages.

## Verified references

- [Corepack README](https://github.com/nodejs/corepack/blob/main/README.md):
  project `packageManager` selects pnpm without changing global default.
- [Zod strict objects](https://zod.dev/api#strictobject):
  `z.strictObject()` rejects unknown keys.
- [Express 5 API](https://expressjs.com/en/api/): Express 5 supports the
  selected Node 22 runtime.
- [Playwright Docker](https://playwright.dev/docs/docker): package and image
  versions must match and image references should be pinned.
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext):
  Playwright 1.61.1 supports `setStorageState()` (added in 1.59) and checkpoint
  export with `storageState({ indexedDB: true })`.
- [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype):
  browser launch/context proxy accepts `{server,bypass}`;
  `connectOverCDP()` is Chromium-only and lower fidelity than Playwright
  protocol, so typed operations use the owned Playwright context.
- [Chromium proxy bypass rules](https://chromium.googlesource.com/chromium/src/+/312b6bf/net/docs/proxy.md):
  Chromium implicitly bypasses localhost and link-local destinations;
  `<-loopback>` subtracts that implicit bypass so the validating proxy sees
  and rejects those requests.
- [Chromium network switches](https://chromium.googlesource.com/chromium/src/+/master/components/network_session_configurator/common/network_switch_list.h):
  `--disable-quic` disables QUIC transport.
- [Chromium WebRTC IP policy switch](https://chromium.googlesource.com/chromium/src/+/c9d0bef66bb7b855634c1de68a19c48966412cc8/content/public/common/content_switches.cc)
  and [policy value](https://chromium.googlesource.com/chromium/src/+/376fc41e87a058f7a7b300b0ec3a4982b4ec0960/components/policy/resources/templates/policy_definitions/Miscellaneous/WebRtcIPHandling.yaml):
  force `disable_non_proxied_udp` so WebRTC cannot use non-proxied UDP.
- Context routing misses service-worker-owned traffic unless service workers
  are blocked. Every context uses `serviceWorkers: "block"`; the DNS-pinning
  egress proxy remains the primary SSRF/rebinding boundary.

### Task 1: Scaffold strict Browser Service contracts

**Files:**
- Create: `apps/browser-service/contracts/private-v1.contract.json`
- Create: `apps/browser-service/package.json`
- Create: `apps/browser-service/pnpm-lock.yaml`
- Create: `apps/browser-service/tsconfig.json`
- Create: `apps/browser-service/src/runtime-preflight.mjs`
- Create: `apps/browser-service/src/runtime-preflight.test.mjs`
- Create: `apps/browser-service/src/lockfile.test.mjs`
- Create: `apps/browser-service/src/contracts.ts`
- Create: `apps/browser-service/src/contract-inventory.ts`
- Create: `apps/browser-service/src/contracts.test.ts`
- Create: `apps/browser-service/src/config.ts`
- Create: `apps/browser-service/src/errors.ts`
- Create: `apps/browser-service/src/auth.ts`
- Create: `apps/browser-service/src/auth.test.ts`

- [ ] **Step 1: Select Node and write dependency-free preflight test**

Select installed runtime first. Then create only
`src/runtime-preflight.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserServiceRuntime } from "./runtime-preflight.mjs";

test("accepts only Node 22.22.1", () => {
  assert.doesNotThrow(() => assertBrowserServiceRuntime("v22.22.1"));
  for (const version of ["v22.22.0", "v23.0.0", "v25.8.2"]) {
    assert.throws(
      () => assertBrowserServiceRuntime(version),
      { category: "browser_service_runtime_mismatch" },
    );
  }
});
```

- [ ] **Step 2: Run dependency-free preflight test and verify red**

Run:

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node --version
node --test apps/browser-service/src/runtime-preflight.test.mjs
```

Expected: version prints `v22.22.1`; test FAIL because
`runtime-preflight.mjs` does not exist. Do not invoke Corepack, pnpm, `tsx`, or
`tsc` yet.

- [ ] **Step 3: Add exact package metadata and runtime preflight**

Create package metadata with no dependency ranges. Every direct dependency and
dev dependency is exactly pinned. Every lifecycle script runs preflight first;
`.mjs` bootstrap/lock tests stay on `node:test` and all TypeScript tests use
Vitest 4.1.9:

```json
{
  "name": "@firecrawl/browser-service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "preinstall": "node src/runtime-preflight.mjs",
    "prebuild": "node src/runtime-preflight.mjs",
    "build": "tsc -p tsconfig.json",
    "prestart": "node src/runtime-preflight.mjs",
    "start": "node dist/index.js",
    "pretest": "node src/runtime-preflight.mjs",
    "test:bootstrap": "node --test src/runtime-preflight.test.mjs src/lockfile.test.mjs",
    "test": "node --test src/runtime-preflight.test.mjs src/lockfile.test.mjs && vitest run"
  },
  "dependencies": {
    "express": "5.2.1",
    "ipaddr.js": "2.4.0",
    "playwright": "1.61.1",
    "ws": "8.21.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "22.20.1",
    "@types/ws": "8.18.1",
    "tsx": "4.23.1",
    "typescript": "5.9.3",
    "vitest": "4.1.9"
  },
  "engines": { "node": "22.22.1" },
  "packageManager": "pnpm@10.33.0"
}
```

`runtime-preflight.mjs` keeps its assertion dependency-free and exposes it for
the Node test:

```js
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertBrowserServiceRuntime(version = process.version) {
  if (version !== "v22.22.1") {
    const error = new Error(
      `browser_service_runtime_mismatch: expected v22.22.1, received ${version}`,
    );
    error.category = "browser_service_runtime_mismatch";
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assertBrowserServiceRuntime();
}
```

Test `v22.22.1` success and `v22.22.0`, `v23.0.0`, and `v25.8.2` category
failure. Configure `NodeNext`, `strict`, `noUncheckedIndexedAccess`, and
`exactOptionalPropertyTypes`.

`lockfile.test.mjs` copies only `package.json` and `pnpm-lock.yaml` to a
temporary directory. One case adds dependency `lockfile-mismatch-probe:
"0.0.0"`; another removes the copied lock. Each invokes
`corepack pnpm install --frozen-lockfile --ignore-scripts` with argument arrays
and asserts nonzero exit before deleting its temporary root.

- [ ] **Step 4: Generate and prove the frozen dependency graph**

Run inside the package so Corepack reads its exact `packageManager`. Corepack
may acquire pnpm `10.33.0`; this project-scoped acquisition is authorized.

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node --version
cd apps/browser-service
node src/runtime-preflight.mjs
corepack pnpm --version
corepack pnpm install --lockfile-only
rm -rf node_modules
corepack pnpm install --frozen-lockfile
corepack pnpm install --frozen-lockfile --lockfile-only
corepack pnpm exec playwright install chromium
corepack pnpm list --depth 0
node src/runtime-preflight.mjs
node --test src/runtime-preflight.test.mjs src/lockfile.test.mjs
```

Expected: `v22.22.1`, `10.33.0`, both frozen commands and lockfile tests pass,
and list reports exactly Express `5.2.1`, `ipaddr.js` `2.4.0`, Playwright
`1.61.1`, `ws` `8.21.1`, Zod `4.4.3`, `@types/express` `5.0.6`,
`@types/node` `22.20.1`, `@types/ws` `8.18.1`, `tsx` `4.23.1`, TypeScript
`5.9.3`, and Vitest `4.1.9` as direct dependencies. Playwright reports its
1.61.1-pinned Chromium executable through `chromium.executablePath()`; Tasks 2
and 4 fail if that exact executable is absent.

- [ ] **Step 5: Write failing closed-schema and auth tests**

Only after frozen install succeeds, create `contracts.test.ts` and
`auth.test.ts`:

Every `*.test.ts` created in Tasks 1-6 explicitly begins with
`import { describe, expect, test, vi } from "vitest";`; use no global test
APIs. Only `runtime-preflight.test.mjs` and `lockfile.test.mjs` import
`node:test` and `node:assert/strict`.

```ts
import { describe, expect, test, vi } from "vitest";

test("action request rejects unknown fields and non-SHA hashes", () => {
  expect(actionExecutionRequestSchema.safeParse({
    version: 1,
    actionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    sequence: 1,
    normalizedProposalHash: "not-a-hash",
    effect: "side_effecting",
    expectedSessionVersion: 0,
    operation: { kind: "click", ref: "e1" },
    extra: true,
  }).success).toBe(false);
});

test("operation union cannot select shell or transport", () => {
  expect(browserOperationSchema.safeParse({
    kind: "shell", command: "id",
  }).success).toBe(false);
});

test("private auth requires key, correlation, and future deadline", () => {
  expect(() => authorizePrivateRequest({
    authorization: "Bearer wrong",
    correlationId: "",
    deadline: new Date(Date.now() - 1).toISOString(),
  }, "expected")).toThrow(/unauthorized|deadline/i);
});

test("reconciliation rejects malformed filesystem authority", () => {
  expect(reconciliationRequestV1Schema.safeParse({
    version: 1,
    processNonce: "A".repeat(43),
    snapshotDigest: "a".repeat(64),
    references: [{
      kind: "replay_checkpoint",
      id: crypto.randomUUID().toUpperCase(),
      path: "../escape.json",
      checksum: "A".repeat(64),
    }],
  }).success).toBe(false);
});

test("health contracts distinguish live, reconciling, and ready", () => {
  expect(liveHealthV1Schema.parse({
    version: 1,
    status: "live_unreconciled",
    processNonce: VALID_NONCE,
  }).status).toBe("live_unreconciled");
  expect(liveHealthV1Schema.parse({
    version: 1,
    status: "reconciling",
    processNonce: VALID_NONCE,
  }).status).toBe("reconciling");
  expect(liveHealthV1Schema.safeParse({
    version: 1,
    status: "draining",
    processNonce: VALID_NONCE,
  }).success).toBe(false);
  expect(readyHealthV1Schema.safeParse({
    version: 1,
    status: "ready",
    processNonce: VALID_NONCE,
    snapshotDigest: "a".repeat(64),
    extra: true,
  }).success).toBe(false);
});

test("service contracts exactly match the canonical V1 inventory", async () => {
  const fixture = await readCanonicalPrivateV1Fixture();
  expect(normalizePrivateV1Inventory(servicePrivateV1Inventory))
    .toEqual(fixture);
  expect(fingerprintPrivateV1Inventory(servicePrivateV1Inventory))
    .toBe(sha256(canonicalJson(fixture)));
});

test("action results reject unsafe JSON and every encoded overflow", () => {
  for (const result of [
    evaluateResult(cyclicObject()), evaluateResult(undefined),
    evaluateResult(Symbol("x")), evaluateResult(1n), evaluateResult(NaN),
    getTextResult("x".repeat(40_001)),
    evaluateResult("x".repeat(32 * 1024 + 1)),
  ]) expect(actionExecutionResultSchema.safeParse(result).success).toBe(false);
  expect(encodedBytes(maximalValidActionResponse))
    .toBeLessThanOrEqual(128 * 1024);
});

test("all direct package versions are exact", async () => {
  const packageJson = await readPackageJson();
  for (const version of Object.values({
    ...packageJson.dependencies, ...packageJson.devDependencies,
  })) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 6: Run contract/auth tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
node src/runtime-preflight.mjs
corepack pnpm exec vitest run src/contracts.test.ts src/auth.test.ts
```

Expected: preflight PASS, then tests FAIL because contracts and auth production
modules do not exist.

- [ ] **Step 7: Define strict operation, health, and reconciliation schemas**

First write the exact canonical fixture and `contract-inventory.ts` described
under Locked private contracts. `contracts.test.ts` parses the fixture,
deep-compares its normalized `routes` and `definitions` to the independently
declared service inventory, and compares SHA-256 fingerprints. The test also
walks `package.json` and asserts every direct dependency string is one exact
version with no `^`, `~`, tag, workspace range, git reference, or URL.

`browserOperationSchema` implements the prerequisite `BrowserOperation`
without renaming fields or widening values. Every object is closed. JSON
values in `evaluate.args` are recursive string/number/boolean/null, array, or
object values; reject non-JSON values and bound the complete serialized
operation.

```ts
const refSchema = z.string().min(1).max(128);
const textSchema = z.string().max(20_000);
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

export const browserOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("click"), ref: refSchema }),
  z.strictObject({ kind: z.literal("fill"), ref: refSchema, value: textSchema }),
  z.strictObject({
    kind: z.literal("type"), ref: refSchema, value: textSchema,
    delayMs: z.number().int().min(0).max(250),
  }),
  z.strictObject({
    kind: z.literal("press"), ref: refSchema,
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("select"), ref: refSchema,
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
  z.strictObject({ kind: z.literal("navigate"), url: z.string().url().max(8_192) }),
  z.strictObject({
    kind: z.literal("evaluate"), expression: textSchema,
    args: z.record(z.string(), jsonValueSchema),
  }),
]);

export const actionExecutionRequestSchema = z.strictObject({
  version: z.literal(1),
  actionId: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().min(1).max(25),
  normalizedProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  effect: z.enum(["read_only", "side_effecting"]),
  expectedSessionVersion: z.number().int().nonnegative(),
  operation: browserOperationSchema,
});

export const boundedPageStateSchema = z.strictObject({
  url: z.string().url().max(8_192),
  title: z.string().max(4_096),
  snapshotExcerpt: z.string().max(40_000),
});

const processNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(
  value => Buffer.from(value, "base64url").length === 32 &&
    Buffer.from(value, "base64url").toString("base64url") === value,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalUuidSchema = z.string().uuid().refine(
  value => value === value.toLowerCase(),
);
const relativeStatePathSchema = z.string().superRefine((value, context) => {
  const segments = value.split("/");
  if (
    new TextEncoder().encode(value).length > 1_024 ||
    value.startsWith("/") || value.includes("\\") ||
    segments.some(segment => segment === "" || segment === "." ||
      segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment))
  ) context.addIssue({ code: "custom", message: "invalid state path" });
});

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

export const reconciliationRequestV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: processNonceSchema,
  snapshotDigest: sha256Schema,
  references: z.array(reconciliationReferenceV1Schema).max(25_000),
}).superRefine((request, context) => {
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
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 16 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "snapshot too large" });
  }
});

export const reconciliationResultV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: processNonceSchema,
  snapshotDigest: sha256Schema,
  retained: z.number().int().nonnegative().max(25_000),
  removed: z.number().int().nonnegative().max(25_000),
  missing: z.literal(0),
  corrupt: z.literal(0),
  ready: z.literal(true),
});

export const liveHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["live_unreconciled", "reconciling", "ready"]),
  processNonce: processNonceSchema,
});
export const unreadyHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("unready"),
  processNonce: processNonceSchema,
  category: z.enum([
    "reconciliation_required",
    "reconciliation_in_progress",
  ]),
});
export const readyHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("ready"),
  processNonce: processNonceSchema,
  snapshotDigest: sha256Schema,
});
```

Define every result and request schema, field, refinement, encoded-size cap,
HTTP status, and artifact metadata header from Locked private contracts.
Create session validates 30..3600 seconds absolute, 10..600 seconds idle,
`activityTtlSeconds <= ttlSeconds`, at most 8 allowed domains, the complete bounded
`ReplayBrowserSettingsV1`, `StorageStateV1`, and checkpoint XOR invariants.
`BrowserOperationResultV1` and its schema replace every service-side
`unknown` result. The recursive JSON-safe validator enforces depth, entry,
key, string, total-byte, prototype, accessor, cycle, finite-number, sparse
array, symbol, undefined, function, and bigint rejection before encoding.

`auth.ts` uses `timingSafeEqual`, rejects expired deadlines or deadlines over
5 minutes away, and returns `{ correlationId, deadline: Date }`. `config.ts`
validates `PORT`, `BROWSER_SERVICE_API_KEY`, `BROWSER_PROFILE_ROOT`,
`LOCAL_BROWSER_STATE_ROOT`, `BROWSER_STATE_NAMESPACE` as canonical lowercase
UUID, `MAX_BROWSER_SESSIONS`, and every bound used below. Resolve all managed
paths under `<canonical root>/<namespace>/`; reconciliation and cleanup never
accept a request-supplied root or namespace.

Add `processNonceSchema`, canonical lowercase UUID/path/SHA-256 reference
schemas, `reconciliationRequestV1Schema`, `reconciliationResultV1Schema`, and
strict live/unready/ready health schemas. Enforce 25,000 references, 16 MiB
encoded request size, unique `(kind,id)`, and same-checksum path aliases with
`superRefine`. Add every reconciliation category from the approved addendum to
`errors.ts`. Task 1 does not mount routes, inspect files, start Chromium, or
connect PostgreSQL.

- [ ] **Step 8: Run tests and build through the frozen install**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
node --test apps/browser-service/src/runtime-preflight.test.mjs apps/browser-service/src/lockfile.test.mjs
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/contracts.test.ts src/auth.test.ts
corepack pnpm --dir apps/browser-service build
```

Expected: tests PASS; build emits `apps/browser-service/dist`.

- [ ] **Step 9: Commit scaffold**

```bash
git add apps/browser-service/contracts/private-v1.contract.json apps/browser-service/package.json apps/browser-service/pnpm-lock.yaml apps/browser-service/tsconfig.json apps/browser-service/src/runtime-preflight.mjs apps/browser-service/src/runtime-preflight.test.mjs apps/browser-service/src/lockfile.test.mjs apps/browser-service/src/contracts.ts apps/browser-service/src/contract-inventory.ts apps/browser-service/src/contracts.test.ts apps/browser-service/src/config.ts apps/browser-service/src/errors.ts apps/browser-service/src/auth.ts apps/browser-service/src/auth.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: define browser service contracts" -m "Add strict private schemas for sessions, typed browser actions,
profiles, streams, and health requests.

Validate service identity, correlation IDs, deadlines, and runtime
configuration."
```

### Task 2: Enforce public egress and DNS pinning

**Files:**
- Create: `apps/browser-service/src/network-policy.ts`
- Create: `apps/browser-service/src/network-policy.test.ts`
- Create: `apps/browser-service/src/egress-proxy.ts`
- Create: `apps/browser-service/src/egress-proxy.test.ts`
- Create: `apps/browser-service/src/chromium-launch-policy.ts`
- Create: `apps/browser-service/src/chromium-egress.integration.test.ts`

- [ ] **Step 1: Write hostile-address, redirect, and rebinding tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("blocks every non-public address form", async () => {
  for (const target of [
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/",
    "http://10.0.0.1/", "http://100.64.0.1/", "file:///etc/passwd",
    "http://192.0.2.1/", "http://198.51.100.1/", "http://203.0.113.1/",
  ]) await expect(resolvePublicTarget(target, fakeLookup)).rejects.toMatchObject({
    category: "target_blocked",
  });
});

test("pins the checked DNS answer", async () => {
  const lookup = sequenceLookup(["93.184.216.34"], ["127.0.0.1"]);
  const dial = recordingDialer();
  await proxyConnect("example.test:8443", { lookup, dial });
  expect(dial.addresses).toEqual(["93.184.216.34"]);
  expect(lookup.calls).toBe(1);
});

test("bundled Chromium sends top-level and subresource traffic to proxy", async () => {
  const result = await exerciseBundledChromiumThroughProxy();
  expect(result.acceptedPublicRequests).toEqual([
    "top-level", "script", "image", "fetch", "websocket",
  ]);
  expect(result.blockedTargets).toEqual(expect.arrayContaining([
    "localhost", "127.0.0.2", "169.254.169.254", "::1", "fe80::1",
    "private.test",
  ]));
  expect(result.privateOriginHits).toBe(0);
});

test("bundled Chromium cannot emit QUIC or WebRTC UDP", async () => {
  const proof = await proveNoNonProxiedUdp();
  expect(proof.baselineQuicPackets).toBeGreaterThan(0);
  expect(proof.baselineWebRtcPackets).toBeGreaterThan(0);
  expect(proof.hardenedQuicPackets).toBe(0);
  expect(proof.hardenedWebRtcPackets).toBe(0);
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/network-policy.test.ts src/egress-proxy.test.ts src/chromium-egress.integration.test.ts
```

Expected: FAIL because policy and proxy do not exist.

- [ ] **Step 3: Implement URL normalization and per-request resolution**

Accept only HTTP(S), no credentials, no `localhost`, and public unicast
addresses. Normalize hostnames with `domainToASCII`, strip one trailing dot,
reject IPv4-mapped blocked IPv6, CGNAT, metadata, private, link-local,
multicast, documentation, reserved, and unspecified ranges. Accept ports
1..65535. Never cache DNS across requests.

```ts
export type ResolvedPublicTarget = {
  url: URL;
  hostname: string;
  port: number;
  addresses: readonly string[];
};
```

- [ ] **Step 4: Implement bounded HTTP/CONNECT proxy**

Dial the validated IP directly and preserve hostname only for `Host` and TLS
SNI. Require absolute-form plain HTTP(S). Parse one explicit CONNECT host and
port; reject credentials, path, query, fragments, whitespace, and control
bytes. Remove proxy-only headers. Follow no redirects inside the proxy.

Use exact bounds: 32 KiB request headers, 64 KiB response headers, 32 MiB
buffered HTTP body, 128 MiB each CONNECT direction, 32 tunnels, 60-second
idle timeout, and `min(private deadline, now + 3600 seconds)` total lifetime.
Bind `127.0.0.1` on an ephemeral port and apply bidirectional backpressure.

- [ ] **Step 5: Lock manual Chromium proxy and direct-UDP defenses**

`chromium-launch-policy.ts` returns the only proxy/argument configuration
allowed for Browser Service contexts:

```ts
export function chromiumNetworkLaunchPolicy(loopbackProxyUrl: string) {
  return {
    proxy: { server: loopbackProxyUrl, bypass: "<-loopback>" },
    args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  } as const;
}
```

Do not omit `bypass`, use an empty bypass string, depend on environment proxy
variables, or route only Playwright page requests. Chromium's implicit bypass
otherwise allows localhost and link-local traffic around the validating
proxy. Task 4 must spread this exact policy into
`chromium.launchPersistentContext()` and may not override either field.

`chromium-egress.integration.test.ts` launches the Playwright 1.61.1 bundled
Chromium executable, not a mocked browser. It serves a controlled public
top-level document whose script creates image, `fetch`, WebSocket, iframe,
worker, and navigation requests. For both top-level and every subresource
class, request `localhost`, another 127/8 address, `169.254.169.254`, `[::1]`,
`[fe80::1]`, and `private.test` whose injected proxy DNS answer is RFC1918.
Record that the proxy receives and rejects every target before dial, while
private HTTP/WS sinks record zero connections. A request absent from proxy
logs or observed by a sink fails the test.

Start two UDP packet sinks. The QUIC proof uses a test-only Chromium launch
with a host-resolver mapping and forced-QUIC origin: first omit
`--disable-quic` and require the sink to observe at least one baseline packet;
then use the production policy and require zero. The WebRTC proof first uses a
local STUN URL without the policy and requires at least one baseline UDP
packet, then repeats with
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and requires zero.
Use fixed fake clocks only outside these real-browser cases. If Chromium,
IPv6, host resolution, QUIC forcing, STUN, packet capture, or the baseline
positive control cannot prove the path, fail rather than skip or weaken the
assertion.

- [ ] **Step 6: Run focused and bundled-Chromium tests**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/network-policy.test.ts src/egress-proxy.test.ts src/chromium-egress.integration.test.ts
```

Expected: PASS for alternate IP forms, rebinding, redirect revalidation,
CONNECT smuggling, bounds, half-close, cancellation, slot release, complete
top-level/subresource proxy observation, private-destination zero hits, and
positive-control-proven QUIC/WebRTC UDP suppression.

- [ ] **Step 7: Commit egress boundary**

```bash
git add apps/browser-service/src/network-policy.ts apps/browser-service/src/network-policy.test.ts apps/browser-service/src/egress-proxy.ts apps/browser-service/src/egress-proxy.test.ts apps/browser-service/src/chromium-launch-policy.ts apps/browser-service/src/chromium-egress.integration.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: enforce browser egress policy" -m "Validate every browser destination, reject internal address ranges, and
pin outbound connections to the checked DNS answer.

Bound HTTP and CONNECT traffic, lifetimes, concurrency, and buffered
content."
```

### Task 3: Reconcile authoritative browser state before readiness

**Files:**
- Create: `apps/browser-service/src/startup-state.ts`
- Create: `apps/browser-service/src/startup-state.test.ts`
- Create: `apps/browser-service/src/reconciliation.ts`
- Create: `apps/browser-service/src/reconciliation.test.ts`

- [ ] **Step 1: Write failing process-state and nonce tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("starts live but rejects work until the current nonce is reconciled", () => {
  const state = createStartupState({
    randomBytes: () => Buffer.alloc(32, 7),
  });
  expect(state.liveHealth()).toEqual({
    version: 1,
    status: "live_unreconciled",
    processNonce: Buffer.alloc(32, 7).toString("base64url"),
  });
  expect(() => state.requireReady()).toThrow(expect.objectContaining({
    category: "reconciliation_required",
  }));
});

test("caches only an exact successful nonce and digest", async () => {
  const state = createStartupState({ randomBytes: fixedRandomBytes });
  const first = await state.reconcile(validRequest, reconcileOnce);
  const retry = await state.reconcile(validRequest, reconcileOnce);
  expect(retry).toEqual(first);
  expect(reconcileOnce).toHaveBeenCalledTimes(1);
  await expect(state.reconcile({
    ...validRequest,
    snapshotDigest: "f".repeat(64),
  }, reconcileOnce)).rejects.toMatchObject({
    category: "reconciliation_conflicting_replay",
  });
});
```

Assert two process instances receive different 43-character nonces; a wrong
nonce performs no callback; a failed callback returns to
`live_unreconciled`; `beginDraining()` closes admission permanently; health
objects contain no path, checksum, key, URL, public browser ID, or capability.

- [ ] **Step 2: Write failing filesystem reconciliation tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("validates all authorities before quarantining one old orphan", async () => {
  const fixture = await createStateFixture({
    referencedCheckpoint: true,
    referencedProfile: true,
    oldUnreferencedCheckpoint: true,
  });
  const result = await reconcileBrowserState(fixture.root, fixture.request, {
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  });
  expect(result).toMatchObject({
    retained: 2,
    removed: 1,
    missing: 0,
    corrupt: 0,
    ready: true,
  });
  expect(await fixture.exists("checkpoints/referenced.json")).toBe(true);
  expect(await fixture.exists("checkpoints/orphan.json")).toBe(false);
});

test("one corrupt authority causes zero deletion", async () => {
  const fixture = await createStateFixture({
    corruptReferencedCheckpoint: true,
    oldUnreferencedCheckpoint: true,
  });
  await expect(reconcileBrowserState(
    fixture.root,
    fixture.request,
    fixture.deps,
  )).rejects.toMatchObject({ category: "reconciliation_reference_corrupt" });
  expect(await fixture.exists("checkpoints/orphan.json")).toBe(true);
});
```

Cover missing authority, traversal, absolute/backslash/control paths,
symlinks, sockets, devices, FIFOs, unexpected hard links, unknown names,
entry 25,001, path/checksum aliases, younger-than-10-minute entries, partial
rename/delete/fsync failure, and exact retry from quarantine. Every rejected
request must prove no eligible entry changed.

- [ ] **Step 3: Run focused tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/startup-state.test.ts src/reconciliation.test.ts
```

Expected: FAIL because startup state and reconciliation modules do not exist.

- [ ] **Step 4: Implement process-local startup state**

Expose this closed interface from `startup-state.ts`:

```ts
export type StartupAdmission = {
  processNonce: string;
  requireReady(): { processNonce: string; snapshotDigest: string };
  liveHealth(): LiveHealthV1;
  readyHealth(): ReadyHealthV1 | UnreadyHealthV1;
  reconcile(
    request: ReconciliationRequestV1,
    execute: (
      request: ReconciliationRequestV1,
    ) => Promise<ReconciliationResultV1>,
  ): Promise<ReconciliationResultV1>;
  beginDraining(): void;
};

export function createStartupState(deps?: {
  randomBytes?: (size: number) => Buffer;
}): StartupAdmission;
```

Generate exactly 32 bytes with `node:crypto.randomBytes`, encode unpadded
base64url, and never persist or log the nonce. Serialize reconciliation per
process. Validate nonce before calling filesystem code. Cache only successful
same-digest result; preserve current readiness on conflicting replay. A failed
attempt remains retryable and unready. `requireReady()` throws
`reconciliation_required` outside `ready` and after draining.

- [ ] **Step 5: Implement validate-plan-quarantine reconciliation**

Expose this filesystem-only boundary:

```ts
export type ReconciliationDependencies = {
  now?: () => Date;
  gracePeriodMs?: number;
  maxManagedEntries?: number;
  correlationId?: string;
  logger?: Pick<Logger, "info" | "error">;
};

export function canonicalizeReconciliationSnapshot(
  references: readonly ReconciliationReferenceV1[],
): { canonicalJson: string; snapshotDigest: string };

export async function reconcileBrowserState(
  canonicalRoot: string,
  request: ReconciliationRequestV1,
  deps?: ReconciliationDependencies,
): Promise<ReconciliationResultV1>;
```

First parse the complete closed request, recompute digest, and validate every
authority. `canonicalRoot` is constructed once at startup from configured
`LOCAL_BROWSER_STATE_ROOT/BROWSER_STATE_NAMESPACE`; no route, snapshot, API,
or harness request can replace it. Resolve only root-relative paths beneath
that owned canonical namespace. Reject
symlinks, root escapes, special files, hard-link ambiguity, unrecognized
directory grammar, and checksum mismatch. Check checkpoint canonical JSON SHA
and profile-generation canonical tree SHA by the foundation algorithms.

Only after all authorities pass, enumerate at most 25,000 entries in checked-in
checkpoint, profile committed/staging/working, and quarantine namespaces.
Retain every reference, including cleanup intents and active/latest profile
generations supplied by API. Eligible deletion requires recognized ownership,
absence from snapshot, and age greater than 10 minutes. Rename each candidate
within the root to `quarantine/<processNonce>/<managed-name>`, fsync parent,
delete it, and fsync again. Existing matching quarantine makes exact retry
continue. Unknown entries fail readiness untouched. Reconciliation never
changes database paths or promotes a generation.

Log one bounded aggregate record containing category, correlation ID, state,
counts, duration, and result. Test captured logs contain none of request paths,
IDs, hashes, nonce, service key, database/private URL, profile/public browser
identity, capability, or grant.

- [ ] **Step 6: Run reconciliation tests and package build**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/startup-state.test.ts src/reconciliation.test.ts
corepack pnpm --dir apps/browser-service build
```

Expected: tests PASS for fail-before-delete, quarantine retry, nonce/digest
rules, admission, bounds, and redaction; build PASS.

- [ ] **Step 7: Commit startup reconciliation**

```bash
git add apps/browser-service/src/startup-state.ts apps/browser-service/src/startup-state.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: reconcile browser state before readiness" -m "Bind readiness to one process nonce and one authoritative snapshot.

Validate every retained file before quarantining recognized old orphans."
```

### Task 4: Add immutable profiles and persistent session lifecycle

**Files:**
- Create: `apps/browser-service/src/profile-store.ts`
- Create: `apps/browser-service/src/profile-store.test.ts`
- Create: `apps/browser-service/src/session-registry.ts`
- Create: `apps/browser-service/src/session-registry.test.ts`
- Create: `apps/browser-service/src/replay-restore.ts`
- Create: `apps/browser-service/src/replay-restore.integration.test.ts`

- [ ] **Step 1: Write profile crash-boundary and TTL tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("publishes a writer generation through prepare and finalize", async () => {
  const work = await store.createWorkingCopy(profileId, null, "writer", sessionId);
  await writeFile(join(work.path, "Cookies"), "state");
  const prepared = await store.prepareWorkingCopy(work);
  expect(await store.hasCommitted(prepared.generationId)).toBe(false);
  const committed = await store.finalizePreparedGeneration(prepared);
  expect(committed.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(await store.hasCommitted(prepared.generationId)).toBe(true);
});

test("expires at first idle or absolute deadline", async () => {
  const session = await registry.create(baseRequest({
    ttlSeconds: 60, activityTtlSeconds: 10,
  }));
  clock.advance(10_001);
  await registry.sweepExpired();
  expect(registry.get(session.runtimeSessionId)).toBeUndefined();
});

test("cannot create a profile or Chromium session before reconciliation", async () => {
  await expect(registry.create(baseRequest({}))).rejects.toMatchObject({
    category: "reconciliation_required",
  });
  expect(launchPersistentContext).not.toHaveBeenCalled();
  expect(profileStore.createWorkingCopy).not.toHaveBeenCalled();
});

test("real Chromium restores storage before its first network request", async () => {
  const restored = await restoreRealCheckpoint({
    cookies: true, localStorage: true, indexedDB: true,
  });
  expect(restored.preRestoreNetworkRequests).toBe(0);
  expect(restored.documentValues).toEqual(EXPECTED_STORAGE_VALUES);
  expect(restored.exportedCanonicalBytes).toEqual(
    restored.checkpointStorageCanonicalBytes,
  );
  expect(restored.exportedChecksum).toBe(restored.checkpointStorageChecksum);
});

test("restore crash discards work and never publishes a profile", async () => {
  await expect(restoreRealCheckpoint({ crashAfterSetStorageState: true }))
    .rejects.toMatchObject({ category: "replay_unavailable" });
  expect(await profileStore.listStaging()).toEqual([]);
  expect(await profileStore.listCommitted()).toEqual([]);
  expect(await profileStore.listWorking()).toEqual([]);
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/profile-store.test.ts src/session-registry.test.ts src/replay-restore.integration.test.ts
```

Expected: FAIL because profile store and registry do not exist.

- [ ] **Step 3: Implement root-confined two-phase profile publication**

Derive every path from UUIDs. Writer close fsyncs a working tree, renames it
to staging, hashes it, and returns an opaque prepare token. Finalize verifies
token and checksum, atomically renames staging to committed, and is idempotent
for the same generation/checksum. Snapshot sessions never publish.

API advances `latest_generation_id` only after finalize succeeds. Consume the
Task 3 reconciled root; this store never changes readiness, queries authority,
or promotes an orphan generation.

- [ ] **Step 4: Implement persistent Chromium sessions and replay**

Create a new UUID-derived isolated working profile for every session, then
launch one `chromium.launchPersistentContext()` with `headless: true`,
`acceptDownloads: false`, `serviceWorkers: "block"`, validated replay device,
locale, timezone, geolocation, headers, TLS settings, and the exact Task 2
policy `{proxy:{server:loopbackProxyUrl,bypass:"<-loopback>"},args:[
"--disable-quic",
"--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]}`. Unknown
device/timezone/proxy references return `replay_unsupported` before creating a
working copy or launching Chromium.

An existing profile generation and a replay checkpoint are mutually
exclusive. Reject that combination as `replay_unsupported` before filesystem,
proxy, or Chromium side effects. Replay may use no profile or a new profile
with null generation; the latter begins empty and may publish only after a
successful session close.

Restore checkpoints only from UUID-derived paths under
`LOCAL_BROWSER_STATE_ROOT`. Before launch, parse the exact closed checkpoint,
re-encode fixed-key canonical JSON, verify `byteSize` and SHA-256, and derive
the expected canonical storage-state bytes, byte count, and SHA-256. After
launch, perform this exact order with no page creation, navigation, locator,
script evaluation, listener that can initiate work, access to Chromium's
automatic `about:blank` page, or other network-capable operation between
steps:

```ts
const context = await chromium.launchPersistentContext(
  isolatedWorkingProfile,
  launchOptions,
);
await context.setStorageState(checkpoint.storageState);
const accepted = await context.storageState({ indexedDB: true });
verifyCanonicalStorageState(accepted, checkpoint.storageState);
```

`verifyCanonicalStorageState()` independently validates the bounded closed
schema, sorts cookie/origin/localStorage/database/store/record/index arrays by
their stable identity keys, preserves record order where identity is absent,
omits absent optional fields, emits fixed-key whitespace-free UTF-8 JSON, and
requires exact canonical bytes, byte count, and SHA-256 equal the expected
checkpoint storage payload. It does not manually write cookies,
`localStorage`, or IndexedDB. Only after equality may the registry select the
automatic blank page or create one, load `finalUrl`, then compare exact final
URL and bounded title/body hashes. Do not replay saved actions or side effects.

Any parse, checksum, byte-size, `setStorageState`, immediate export,
canonicalization, equality, navigation, or fingerprint mismatch; timeout; or
Chromium crash closes context/browser and proxy, recursively discards the
isolated working profile, leaves no session in registry, and never prepares,
stages, finalizes, or publishes a profile generation. Cleanup failure is
surfaced and remains reconciliation-owned; runtime work is never admitted.

Registry accepts `StartupAdmission` and calls `requireReady()` before any path,
working-copy, proxy, or Chromium side effect. Registry stores public/runtime
IDs, state/version, page/context, profile work,
initial/allowed/learned origins, deadlines, DevTools loopback endpoint, stream
hub, and one writer lease. `withWriter()` rejects concurrent mutation with
`concurrency_exceeded`; `touch()` moves only idle deadline. Close is
idempotent and closes Chromium before preparing a writer profile.

- [ ] **Step 5: Run lifecycle tests**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/profile-store.test.ts src/session-registry.test.ts src/replay-restore.integration.test.ts
```

Expected: PASS for writer exclusion, snapshot isolation, every publication
crash point, corrupt-reference readiness, 600-second idle and 3600-second
absolute maxima, shorter caller limits, and close idempotency. Real bundled
Chromium proves cookies, localStorage, and IndexedDB exist before first
navigation; sinks prove no pre-restore request. Canonical byte/checksum
mismatch, timeout, and forced crash leave no registry/profile publication.

- [ ] **Step 6: Commit profile lifecycle**

```bash
git add apps/browser-service/src/profile-store.ts apps/browser-service/src/profile-store.test.ts apps/browser-service/src/session-registry.ts apps/browser-service/src/session-registry.test.ts apps/browser-service/src/replay-restore.ts apps/browser-service/src/replay-restore.integration.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: persist browser profile generations" -m "Create isolated Chromium working copies and publish writable profile
generations through a checksummed two-phase protocol.

Restore replay checkpoints and enforce session writer, idle, and
absolute lifetime rules."
```

### Task 5: Execute typed operations once

**Files:**
- Create: `apps/browser-service/src/evaluate-policy.ts`
- Create: `apps/browser-service/src/evaluate-policy.test.ts`
- Create: `apps/browser-service/src/operations.ts`
- Create: `apps/browser-service/src/operations.test.ts`
- Create: `apps/browser-service/src/action-cache.ts`
- Create: `apps/browser-service/src/action-cache.test.ts`
- Modify: `apps/browser-service/src/session-registry.ts`

- [ ] **Step 1: Write operation and deduplication tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("returns a cached known result for matching action replay", async () => {
  const first = await executeAction(session, clickAction);
  const replay = await executeAction(session, clickAction);
  expect(first).toEqual(replay);
  expect(page.click).toHaveBeenCalledTimes(1);
});

test("rejects action or sequence reuse with another hash", async () => {
  await executeAction(session, clickAction);
  await expect(executeAction(session, {
    ...clickAction,
    normalizedProposalHash: "f".repeat(64),
  })).rejects.toMatchObject({ category: "model_protocol_error" });
});

test("direct navigation requires existing origin or allowed domain", async () => {
  await expect(executeOperation(session, {
    kind: "navigate", url: "https://other.test/",
  })).rejects.toMatchObject({ category: "target_blocked" });
});

test("rejects every non-JSON-safe evaluate result as ambiguous", async () => {
  for (const value of [cyclicObject(), undefined, Symbol("x"), 1n, NaN,
    Infinity]) {
    await expect(executeEvaluateResult(value)).rejects.toMatchObject({
      category: "action_outcome_unknown",
    });
    expect(actionCache.has(evaluateAction.actionId)).toBe(false);
    expect(session.closed).toBe(true);
  }
});

test("bounds each result and complete action response", async () => {
  await expect(executeGetText("x".repeat(40_001))).rejects.toMatchObject({
    category: "action_outcome_unknown",
  });
  await expect(executeEvaluateResult({ value: "x".repeat(32 * 1024) }))
    .rejects.toMatchObject({ category: "action_outcome_unknown" });
  expect(byteLength(validatedActionResponse)).toBeLessThanOrEqual(128 * 1024);
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/evaluate-policy.test.ts src/operations.test.ts src/action-cache.test.ts
```

Expected: FAIL because operation engine and action cache do not exist.

- [ ] **Step 3: Implement constrained evaluate and stable snapshots**

Parse one TypeScript expression. Reject assignment, update, `new`, import,
functions, classes, tagged templates, and identifiers that provide network,
storage, dynamic code, workers, or navigation mutation. Permit explicit
read/call members rooted at `document`, `location`, and `args`.

Snapshots create server-held locator refs capped at 500 and return at most
40,000 characters for `snapshotExcerpt`; `get_text` returns at most 40,000
characters; evaluate result JSON is at most 32 KiB; any operation result is at
most 64 KiB; complete action response is at most 128 KiB. Use the Task 1
`JsonSafe` validator before encoding and reject cyclic, sparse, accessor,
custom-prototype, symbol-keyed, undefined, symbol, function, bigint,
non-finite, depth, count, key, string, and byte-limit violations. Full
operation JSON stays within 64 KiB. Clear refs on navigation. Never add
reference attributes to DOM.

- [ ] **Step 4: Implement operation dispatch and navigation policy**

Dispatch all 12 approved operations under the session writer. Direct
`navigate` requires current origin or validated `allowedDomains`. Before
click, inspect link target; only a validated clicked-link destination may add
an origin. Validate redirects before following. Cap navigation origins at 8.
Validate frames, workers, WebSockets, downloads, and subrequests through the
egress boundary; public CDN/API subrequests never gain navigation authority.
Cancel downloads by default.

- [ ] **Step 5: Implement live action-ID deduplication**

Key cache entries by session and action ID; index sequence separately. Before
dispatch, require the request hash and trusted effect to match the operation.
A matching action ID/sequence/hash returns an existing `succeeded` or
`failed_no_effect` result. Any identity or sequence collision with a different
hash fails `model_protocol_error`. Keep one pending action per session.

Match each success to the exact `BrowserOperationResultV1` discriminant from
Locked private contracts; operation kind and result kind must agree. Validate
and encode the operation result, page state, and complete response before
inserting a terminal cache entry.

Store a known result only after operation completion and complete bounded
serialization. Map only validation,
stale-ref, and browser failures that prove no effect to `failed_no_effect`.
Do not catch disconnect, Chromium crash, timeout after dispatch, or unknown
exceptions as no-effect. Evaluate may mutate before returning: unsupported,
cyclic, or oversized evaluate output and every result/response serialization
failure are terminal ambiguity even when evaluation returned. Close the
session, leave action cache empty, and let failure reach API as ambiguous
transport failure. Never retry an operation.

- [ ] **Step 6: Run operation tests**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/evaluate-policy.test.ts src/operations.test.ts src/action-cache.test.ts
corepack pnpm --dir apps/browser-service test
```

Expected: PASS for all operations, stable/stale refs, payload bounds, origin
expansion, SSRF, unsafe evaluate, matching replay without second dispatch,
hash mismatch, proven no-effect failure, every JSON-safe rejection,
per-operation/full-response caps, no caching after serialization failure, and
ambiguous failure propagation.

- [ ] **Step 7: Commit operation engine**

```bash
git add apps/browser-service/src/evaluate-policy.ts apps/browser-service/src/evaluate-policy.test.ts apps/browser-service/src/operations.ts apps/browser-service/src/operations.test.ts apps/browser-service/src/action-cache.ts apps/browser-service/src/action-cache.test.ts apps/browser-service/src/session-registry.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: execute typed browser actions once" -m "Add bounded browser operations, stable snapshot references, constrained
evaluation, and navigation-set enforcement.

Deduplicate matching action identities and fail closed on hash or
sequence collisions without retrying effects."
```

### Task 6: Serve authenticated sessions, artifacts, and streams

**Files:**
- Create: `apps/browser-service/src/streams.ts`
- Create: `apps/browser-service/src/streams.test.ts`
- Create: `apps/browser-service/src/artifacts.ts`
- Create: `apps/browser-service/src/artifacts.test.ts`
- Create: `apps/browser-service/src/server.ts`
- Create: `apps/browser-service/src/server.test.ts`
- Create: `apps/browser-service/src/dockerfile.test.ts`
- Create: `apps/browser-service/src/index.ts`
- Create: `apps/browser-service/Dockerfile`

- [ ] **Step 1: Write HTTP, action, stream, and artifact tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("action route returns cached output without another effect", async () => {
  const first = await postAction(validAction);
  const replay = await postAction(validAction);
  expect(first.body).toEqual(replay.body);
  expect(operationSpy).toHaveBeenCalledTimes(1);
});

test("passive stream rejects input", async () => {
  const socket = await openStream("passive", passiveGrant);
  socket.send(JSON.stringify({ kind: "pointer", x: 1, y: 1 }));
  expect(await closeCode(socket)).toBe(1008);
});

test("artifact capture is explicit and bounded", async () => {
  const artifact = await captureArtifact(session, {
    kind: "screenshot", format: "png", fullPage: false,
  });
  expect(artifact.byteSize).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/);
});

test("serialization ambiguity closes transport without a terminal body", async () => {
  operationSpy.mockResolvedValueOnce(cyclicObject());
  const response = await postAction(evaluateAction);
  expect(response.transportClosed).toBe(true);
  expect(actionCache.has(evaluateAction.actionId)).toBe(false);
  expect(registry.get(runtimeSessionId)).toBeUndefined();
});

test("live precedes reconciliation while all browser work stays closed", async () => {
  expect((await getPrivate("/health/live")).status).toBe(200);
  expect((await getPrivate("/health/ready")).status).toBe(503);
  expect((await postPrivate("/v1/sessions", validCreate)).body.category)
    .toBe("reconciliation_required");
  const reconciled = await postPrivate("/v1/reconciliation", validSnapshot);
  expect(reconciled.status).toBe(200);
  expect((await getPrivate("/health/ready")).body).toMatchObject({
    status: "ready",
    processNonce: validSnapshot.processNonce,
    snapshotDigest: validSnapshot.snapshotDigest,
  });
});

test("shutdown closes health listener before draining admitted work", async () => {
  const accepted = pauseAfterAuthentication("/v1/sessions", validCreate);
  const shutdown = server.beginShutdown();
  await server.listenerClosed();
  await accepted.continueToAdmission();
  await shutdown;
  expect(accepted.response()).toMatchObject({
    status: 503,
    body: { category: "reconciliation_required" },
  });
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/streams.test.ts src/artifacts.test.ts src/server.test.ts src/dockerfile.test.ts
```

Expected: FAIL because transport modules do not exist.

- [ ] **Step 3: Implement live-view, interactive, and CDP streams**

Use `Page.startScreencast`, maximum 1280x720 JPEG/70 and 10 fps. Interactive
input is a strict pointer/wheel/key/text union capped at 4 KiB and serialized
through the writer. Browser Service relay grants bind session, permission,
expiry, and one connection; retain only SHA-256.

CDP holds the writer for its connection. Parse one JSON object per frame; cap
frames at 256 KiB and outstanding IDs at 64. Reject binary, batch, malformed,
duplicate-ID, unsolicited-response, administrative, permission, download, and
target-creation commands. Validate URL-bearing commands and keep egress rules
active beneath CDP. Never return the DevTools endpoint.

- [ ] **Step 4: Implement bounded artifact capture**

Accept screenshot, checked-in trace preset, or checked-in recording preset.
Run under writer lease. Cap each object at 16 MiB and each run at 8 objects/
32 MiB. Return a stream plus artifact ID, kind, content type, byte size, and
SHA-256. Delete temporary data after stream close; never return a path.

- [ ] **Step 5: Implement authenticated routes and shutdown**

Mount the locked private routes. `POST /actions` parses
`actionExecutionRequestSchema` and calls `registry.executeAction()`.
Profile finalize/delete require profile ID, generation ID, checksum, and
prepare token. Upgrade handling authenticates service identity and one-use
relay grant before selecting stream permission.

Every route uses the exact canonical inventory status, request/response byte
cap, schema, and artifact header set. Before writing JSON, parse the complete
response with the closed schema and enforce encoded length. An ambiguous
action or result serialization failure destroys the session and closes the
transport without a success or `failed_no_effect` body; it never enters the
action cache. Artifact streaming verifies declared length and SHA-256 while
writing and aborts on mismatch.

Create `StartupAdmission` before listener bind. Mount authenticated
`GET /health/live`, `GET /health/ready`, and `POST /v1/reconciliation` before
session routes. Apply 16 MiB raw JSON limit only to reconciliation and smaller
contract bounds elsewhere. Reconciliation validates service key, correlation,
deadline capped at 60 seconds, nonce, schema, and digest before calling
`reconcileBrowserState()`. Every create/action/grant/artifact/stream/profile
route invokes `requireReady()` before touching registry or filesystem.

`beginShutdown()` synchronously closes admission and initiates listener close,
then returns one idempotent full-shutdown promise. `listenerClosed()` resolves
only after listener accepts no new connections. Previously accepted requests
then reach closed `requireReady()` admission and settle; shutdown does not wait
for them before they are released. After accepted requests settle, close
streams, close Chromium with bounded profile save, stop timers, and resolve
full-shutdown promise. `SIGTERM` invokes `beginShutdown()` once. Live remains
process liveness only while listener serves it; ready never performs a
disposable session and never becomes true without current nonce/digest
reconciliation.

- [ ] **Step 6: Resolve immutable Playwright base and add container image**

First verify installed Docker exposes required flags and capture registry
manifest bytes. The SHA-256 of exact raw manifest bytes is the immutable
manifest-list digest:

```bash
docker buildx imagetools inspect --help
docker build --help | rg -- '--no-cache|--pull'
docker buildx imagetools inspect --raw mcr.microsoft.com/playwright:v1.61.1-noble > /tmp/firecrawl-playwright-v1.61.1-noble.manifest.json
sha256sum /tmp/firecrawl-playwright-v1.61.1-noble.manifest.json
```

Expected: help names `--raw`, `--no-cache`, and `--pull`; `sha256sum` emits 64
lowercase hex characters. Prefix that exact emitted value with `sha256:` and
commit it directly after `mcr.microsoft.com/playwright:v1.61.1-noble@` in the
final-stage `FROM`. Re-run `imagetools inspect` against that complete pinned
reference and require success before writing any other Dockerfile stage.

Build dependencies with `node:22.22.1-bookworm-slim`, Corepack, and
`corepack pnpm install --frozen-lockfile`. Final runtime starts from the exact
digest-pinned Noble Playwright reference, copies the exact Node `22.22.1`
runtime from the Node stage, copies frozen production dependencies and build,
and runs as `pwuser`. Only `/var/lib/firecrawl-browser` is writable.

Add a named `browser-test` stage from the same digest-pinned Playwright base.
It copies exact Node, full frozen dependencies, source, and tests, runs as
`pwuser`, and exists only for the two real-browser verification commands.
The final stage copies no tests or dev dependencies.

`dockerfile.test.ts` parses every `FROM`, package metadata, and lockfile. It
requires the Playwright tag `v1.61.1-noble`, an `@sha256:` plus 64 lowercase
hex digest, exact package/lock Playwright `1.61.1`, Node base `22.22.1`, frozen
install, preflight before start, and non-root user.

- [ ] **Step 7: Run server tests and two real no-cache image builds**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
corepack pnpm --dir apps/browser-service exec vitest run src/streams.test.ts src/artifacts.test.ts src/server.test.ts src/dockerfile.test.ts
docker build --pull --no-cache --target browser-test -t firecrawl-local-browser-service:browser-test-1 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:browser-test-1 src/runtime-preflight.mjs
docker run --rm --entrypoint corepack firecrawl-local-browser-service:browser-test-1 pnpm exec vitest run src/chromium-egress.integration.test.ts src/replay-restore.integration.test.ts
docker build --pull --no-cache -t firecrawl-local-browser-service:test-1 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:test-1 --version
docker run --rm --entrypoint node firecrawl-local-browser-service:test-1 -p 'require("playwright/package.json").version'
docker image inspect firecrawl-local-browser-service:test-1 --format '{{.Config.User}}'
docker build --pull --no-cache --target browser-test -t firecrawl-local-browser-service:browser-test-2 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:browser-test-2 src/runtime-preflight.mjs
docker run --rm --entrypoint corepack firecrawl-local-browser-service:browser-test-2 pnpm exec vitest run src/chromium-egress.integration.test.ts src/replay-restore.integration.test.ts
docker build --pull --no-cache -t firecrawl-local-browser-service:test-2 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:test-2 --version
docker run --rm --entrypoint node firecrawl-local-browser-service:test-2 -p 'require("playwright/package.json").version'
docker image inspect firecrawl-local-browser-service:test-2 --format '{{.Config.User}}'
```

Expected: tests PASS; both builds succeed from committed digest; each image
reports `v22.22.1`, `1.61.1`, and user `pwuser`. Re-run the raw-manifest
hash and require it equals Dockerfile digest after both builds. Both images
also pass positive-control-proven egress/UDP and storage-restore tests using
their bundled Chromium; an unavailable proof fails the build gate.

- [ ] **Step 8: Commit service transport**

```bash
git add apps/browser-service/src/streams.ts apps/browser-service/src/streams.test.ts apps/browser-service/src/artifacts.ts apps/browser-service/src/artifacts.test.ts apps/browser-service/src/server.ts apps/browser-service/src/server.test.ts apps/browser-service/src/dockerfile.test.ts apps/browser-service/src/index.ts apps/browser-service/Dockerfile
apps/api/.husky/_/pre-commit
git commit -m "feat: serve private browser sessions" -m "Add authenticated session, action, profile, artifact, health, live-view,
and CDP transports around persistent Chromium.

Close streams, actions, and sessions in order during shutdown."
```

### Task 7: Add typed API client and local feature gate

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/lib/local-runtime-config.ts`
- Modify: `apps/api/src/lib/local-runtime-config.test.ts`
- Create: `apps/api/src/lib/scrape-interact/browser-service-contracts.ts`
- Create: `apps/api/src/lib/scrape-interact/browser-service-contracts.test.ts`
- Modify: `apps/api/src/lib/scrape-interact/browser-service-client.ts`
- Create: `apps/api/src/lib/scrape-interact/browser-service-client.test.ts`

- [ ] **Step 1: Write fail-closed config and client tests**

```ts
it("requires private URL and key when enabled", () => {
  expect(() => resolveLocalRuntimeConfig(enabledBase({
    BROWSER_SERVICE_URL: undefined,
    BROWSER_SERVICE_API_KEY: undefined,
  }))).toThrow(/BROWSER_SERVICE_URL.*BROWSER_SERVICE_API_KEY/s);
});

it("locks bounded reconciliation retry defaults", () => {
  expect(resolveLocalRuntimeConfig(enabledBase({}))).toMatchObject({
    browserReconciliationMaxAttempts: 4,
    browserReconciliationInitialBackoffMs: 250,
    browserReconciliationMaxBackoffMs: 2_000,
    browserReconciliationStartupBudgetMs: 60_000,
    browserReconciliationMonitorIntervalMs: 5_000,
    browserReconciliationRetryCooldownMs: 30_000,
  });
});

it("rejects unbounded reconciliation retry configuration", () => {
  expect(() => resolveLocalRuntimeConfig(enabledBase({
    BROWSER_RECONCILIATION_MAX_ATTEMPTS: "0",
  }))).toThrow(/BROWSER_RECONCILIATION_MAX_ATTEMPTS/);
  expect(() => resolveLocalRuntimeConfig(enabledBase({
    BROWSER_RECONCILIATION_INITIAL_BACKOFF_MS: "2000",
    BROWSER_RECONCILIATION_MAX_BACKOFF_MS: "1000",
  }))).toThrow(/BROWSER_RECONCILIATION_MAX_BACKOFF_MS/);
  expect(() => resolveLocalRuntimeConfig(enabledBase({
    BROWSER_RECONCILIATION_STARTUP_BUDGET_MS: "60001",
  }))).toThrow(/BROWSER_RECONCILIATION_STARTUP_BUDGET_MS/);
});

it("posts exact action identity with auth and deadline", async () => {
  await client.executeAction(runtimeId, action, context);
  expect(fetchMock).toHaveBeenCalledWith(
    `http://browser-service:3010/v1/sessions/${runtimeId}/actions`,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      body: JSON.stringify(action),
      headers: expect.objectContaining({
        authorization: "Bearer secret",
        "x-firecrawl-correlation-id": context.correlationId,
        "x-firecrawl-deadline": context.deadline.toISOString(),
      }),
    }),
  );
});

it("binds reconciliation to current live nonce and closed result", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(200, liveHealth))
    .mockResolvedValueOnce(jsonResponse(200, reconciliationResult))
    .mockResolvedValueOnce(jsonResponse(200, readyHealth));
  expect(await client.getLive(context)).toEqual(liveHealth);
  expect(await client.reconcile(snapshot, context)).toEqual(
    reconciliationResult,
  );
  expect(await client.getReady(context)).toEqual(readyHealth);
});

it("matches the canonical V1 inventory without service imports", () => {
  expect(apiPrivateV1Inventory).toEqual(canonicalPrivateV1Inventory);
  expect(apiPrivateV1Fingerprint).toBe(canonicalPrivateV1Fingerprint);
});

it("rejects unsafe or oversized action results at the client boundary", async () => {
  for (const body of [cyclicJsonFixture, undefinedResultFixture,
    nonFiniteFixture, oversizedGetTextFixture, oversizedResponseFixture]) {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
    await expect(client.executeAction(runtimeId, action, context))
      .rejects.toMatchObject({ category: "browser_service_protocol_error" });
  }
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run src/lib/local-runtime-config.test.ts src/lib/scrape-interact/browser-service-contracts.test.ts src/lib/scrape-interact/browser-service-client.test.ts
```

Expected: FAIL because enabled-service validation and typed action client are
absent.

- [ ] **Step 3: Add enabled local configuration**

Add `BROWSER_SERVICE_URL`, 32+ byte `BROWSER_SERVICE_API_KEY`, request timeout,
reconciliation timeout capped at 60 seconds,
`BROWSER_RECONCILIATION_MAX_ATTEMPTS=4`,
`BROWSER_RECONCILIATION_INITIAL_BACKOFF_MS=250`,
`BROWSER_RECONCILIATION_MAX_BACKOFF_MS=2000`,
`BROWSER_RECONCILIATION_STARTUP_BUDGET_MS=60000`,
`BROWSER_RECONCILIATION_MONITOR_INTERVAL_MS=5000`, and
`BROWSER_RECONCILIATION_RETRY_COOLDOWN_MS=30000`, plus
absolute `BROWSER_ADAPTER_TOKEN_FILE`. Enabled mode requires local
persistence, browser-state root, canonical lowercase UUID
`BROWSER_STATE_NAMESPACE`, private HTTP service URL, and key. Adapter
token absence keeps only host callbacks/prompt/code execution unavailable; it
does not disable direct Browser create/list/delete.

Validate attempts 1..8, initial backoff 100..5,000 ms, maximum backoff greater
than or equal to initial and at most 10,000 ms, startup budget 5,000..60,000
ms, monitor interval 1,000..60,000 ms, and cooldown 5,000..300,000 ms. Tests
lock defaults and reject zero, negative, noninteger, reversed, or out-of-range
values.

- [ ] **Step 4: Implement closed typed client methods**

Implement the exact Locked private contracts again in
`browser-service-contracts.ts`; do not import Browser Service TypeScript.
Export `BrowserOperationResultV1` as `z.infer` of its one API-owned strict
schema; later API modules import that type/schema instead of redeclaring it.
Normalize the API inventory, compare it with
`apps/browser-service/contracts/private-v1.contract.json`, and compute SHA-256 over
the fixture's canonical bytes. Never import service schemas, types, inventory,
or fingerprints. Fail on any route, method, status, field, type, bound,
header, streaming rule, or body cap drift.

Provide create/query, `executeAction`, grant create/revoke, artifact, close,
profile finalize/discard, and these closed startup methods:

```ts
getLive(context: BrowserServiceRequestContext): Promise<LiveHealthV1>;
getReady(context: BrowserServiceRequestContext): Promise<ReadyHealthV1 | UnreadyHealthV1>;
reconcile(
  request: ReconciliationRequestV1,
  context: BrowserServiceRequestContext,
): Promise<ReconciliationResultV1>;
```

Use the exact Task 1 schemas mirrored at this trusted boundary. Use
`AbortSignal.any([ctx.signal, AbortSignal.timeout(limit)])`. Parse success and
typed errors with Zod. Reject private redirects. Remove any generic
caller-supplied method/path helper. Never include response bodies or private
URLs in public errors.

`getLive` parses only `live_unreconciled`, `reconciling`, and `ready`.
`getReady` accepts 200 ready or 503 unready, and `reconcile` caps deadline and
encoded body at 60 seconds and 16 MiB. All three always send bearer key,
correlation ID, and absolute deadline.

All other client methods lock literal method/path/status and parse the exact
request/response schema before or after transport. Artifact fetch validates
metadata headers, media type, declared length, 16 MiB cap, and streamed hash.
Action success parses the operation-specific strict result and 64/128 KiB
caps. A malformed/unsafe response is `browser_service_protocol_error`; after
dispatch the caller must treat it as outcome ambiguity, not no-effect.

- [ ] **Step 5: Run tests and build**

```bash
pnpm --dir apps/api exec vitest run src/lib/local-runtime-config.test.ts src/lib/scrape-interact/browser-service-contracts.test.ts src/lib/scrape-interact/browser-service-client.test.ts
pnpm --dir apps/api build
```

Expected: tests and build PASS.

- [ ] **Step 6: Commit client and gate**

```bash
git add apps/api/src/config.ts apps/api/src/lib/local-runtime-config.ts apps/api/src/lib/local-runtime-config.test.ts apps/api/src/lib/scrape-interact/browser-service-contracts.ts apps/api/src/lib/scrape-interact/browser-service-contracts.test.ts apps/api/src/lib/scrape-interact/browser-service-client.ts apps/api/src/lib/scrape-interact/browser-service-client.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: gate local browser service" -m "Require explicit private Browser Service configuration and add closed,
deadline-aware client methods for its runtime contracts.

Sanitize transport failures without leaking private endpoints."
```

### Task 8: Gate API startup on authoritative reconciliation

**Files:**
- Create: `apps/api/src/lib/browser-runtime/startup-gate.ts`
- Create: `apps/api/src/lib/browser-runtime/startup-gate.test.ts`
- Create: `apps/api/src/lib/browser-runtime/reconciliation-snapshot.ts`
- Create: `apps/api/src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts`
- Create: `apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts`
- Create: `apps/api/src/lib/browser-runtime/reconciliation-coordinator.test.ts`
- Modify: `apps/api/src/lib/browser-state/store.ts`
- Modify: `apps/api/src/lib/browser-state/store.integration.test.ts`
- Modify: `apps/api/src/lib/browser-state/filesystem-store.ts`
- Modify: `apps/api/src/lib/scrape-interact/replay-store.ts`
- Modify: `apps/api/src/lib/scrape-interact/replay-store.integration.test.ts`
- Modify: `apps/api/src/services/local-retention-worker.ts`
- Modify: `apps/api/src/services/local-retention-worker.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write failing closed-gate and snapshot tests**

```ts
it("closes admission synchronously and exposes mutation drain", async () => {
  const gate = createBrowserStartupGate();
  expect(() => gate.assertOpen()).toThrow(expect.objectContaining({
    category: "browser_state_unavailable",
  }));
  const initialDrain = gate.close("startup");
  await initialDrain.drained;
  gate.open(initialDrain, {
    processNonce: VALID_NONCE,
    snapshotDigest: VALID_DIGEST,
  });
  let releaseMutation!: () => void;
  const mutation = gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    () => new Promise<void>(resolve => { releaseMutation = resolve; }),
  );
  const restartDrain = gate.close("browser_service_restart");
  expect(() => gate.assertOpen()).toThrow(expect.objectContaining({
    category: "browser_state_unavailable",
  }));
  expect(await promiseState(restartDrain.drained)).toBe("pending");
  await expect(gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    async () => undefined,
  )).rejects.toMatchObject({ category: "browser_state_unavailable" });
  releaseMutation();
  await mutation;
  await restartDrain.drained;
  gate.open(restartDrain, {
    processNonce: VALID_NONCE,
    snapshotDigest: VALID_DIGEST,
  });
  expect(gate.assertOpen()).toEqual({
    processNonce: VALID_NONCE,
    snapshotDigest: VALID_DIGEST,
  });
});

it("loads every nondeleted authority in one repeatable-read snapshot", async () => {
  await seedCheckpoint({ statePath: "checkpoints/a.json" });
  await seedProfileGeneration({ statePath: "profiles/a/committed/1" });
  await seedCleanupIntent({ statePath: "checkpoints/old.json" });
  const snapshot = await loadBrowserReconciliationSnapshot(pool);
  expect(snapshot.references.map(reference => reference.kind).sort()).toEqual([
    "profile_generation",
    "replay_checkpoint",
    "replay_checkpoint_cleanup_intent",
  ]);
  expect(snapshot.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
});

it("snapshots only after an in-flight database mutation drains", async () => {
  await openGateForTest(gate);
  const mutation = gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    async lease => persistCheckpointAndIntent(pool, filesystem, lease),
  );
  await mutationReachedDatabaseBarrier();
  const drain = gate.close("restart");
  await expect(newCheckpointMutation(gate)).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  releaseDatabaseBarrier();
  await mutation;
  await drain.drained;
  const snapshot = await loadBrowserReconciliationSnapshot(pool);
  expect(snapshot.references).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "replay_checkpoint" }),
    expect.objectContaining({ kind: "replay_checkpoint_cleanup_intent" }),
  ]));
});
```

The integration test also seeds latest and active-session generations and
proves they are included by the same generation query. It rejects null/malformed
checksum, invalid path, conflicting path aliases, and authority 25,001 instead
of truncating. Hold a concurrent insert after first query and prove it is not
visible in the transaction's later reads.

- [ ] **Step 2: Write failing startup, restart, and retention-order tests**

```ts
it("opens work and retention only after matching response and ready health", async () => {
  await coordinator.initialize();
  expect(events).toEqual([
    "gate:close",
    "browser-retention:pause",
    "mutations:drained",
    "recovery:interrupt",
    "cleanup-intents:recover",
    "service:live",
    "snapshot:repeatable-read",
    "service:reconcile",
    "service:ready",
    "gate:open",
    "browser-retention:start",
  ]);
});

it("coalesces restart detection and never resumes old sessions", async () => {
  await coordinator.initialize();
  serviceReady.mockResolvedValue(restartedUnreadyHealth);
  await Promise.all([
    coordinator.checkNow(),
    coordinator.checkNow(),
    coordinator.checkNow(),
  ]);
  expect(interruptUnfinishedBrowserWork).toHaveBeenCalledTimes(2);
  expect(serviceClient.reconcile).toHaveBeenCalledTimes(2);
  expect(resumeBrowserSession).not.toHaveBeenCalled();
});

it("recovers only dead cleanup-intent writers before snapshot", async () => {
  inspectProcessIdentity
    .mockResolvedValueOnce("live")
    .mockResolvedValueOnce("unknown")
    .mockResolvedValueOnce("dead")
    .mockResolvedValueOnce("dead");
  filesystem.delete
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Object.assign(new Error("missing"), {
      code: "ENOENT",
    }));
  const result = await recoverBrowserCleanupIntentsBeforeSnapshot(deps);
  expect(result).toEqual({
    liveRetained: 1,
    unknownRetained: 1,
    deadRecovered: 1,
    missingConverged: 1,
  });
  expect(casDeleteIntent).toHaveBeenCalledTimes(2);
});

it("bounds retries, backoff, startup budget, and exhaustion", async () => {
  serviceClient.reconcile.mockRejectedValue(new TransportClosedError());
  await expect(coordinator.initialize()).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  expect(serviceClient.reconcile).toHaveBeenCalledTimes(4);
  expect(fakeClock.sleeps).toEqual([250, 500, 1_000]);
  expect(fakeClock.elapsedMs).toBeLessThanOrEqual(60_000);
  expect(startBrowserRetention).not.toHaveBeenCalled();
  expect(() => startupGate.assertOpen()).toThrow(expect.objectContaining({
    category: "browser_state_unavailable",
  }));
});

it("holds same failed runtime nonce for cooldown", async () => {
  await exhaustRuntimeCycleForNonce(VALID_NONCE);
  fakeClock.advanceBy(29_999);
  await fakeClock.runDueTimers();
  expect(serviceClient.reconcile).toHaveBeenCalledTimes(4);
  await coordinator.checkNow();
  expect(serviceClient.reconcile).toHaveBeenCalledTimes(8);
});

it("runs non-browser retention once when browser feature is disabled", async () => {
  const app = await startApi({ LOCAL_BROWSER_SERVICE_ENABLED: "false" });
  await retentionClock.runOneIteration();
  expect(operationalRetention).toHaveBeenCalledTimes(1);
  expect(artifactRetention).toHaveBeenCalledTimes(1);
  expect(browserStateRetention).not.toHaveBeenCalled();
  expect(createBrowserReconciliationCoordinator).not.toHaveBeenCalled();
  await app.stop();
});
```

Add mismatched result nonce/digest, ready mismatch, timeout, auth, transport,
database, malformed response, interrupted recovery, and second-reconciliation
failure cases. Each leaves gate closed and retention paused. Assert public
mapping is only `browser_state_unavailable` and logs omit paths, IDs, hashes,
nonce, bearer key, private/database URLs, profile/browser identity,
capability, and grant.

Add fake-clock retry tests. Attempts start immediately, then wait exactly 250,
500, and 1,000 ms before attempts 2, 3, and 4. A 60,000 ms total budget caps
every request deadline and cancels remaining backoff. Initial startup
exhaustion throws sanitized `browser_state_unavailable` so API startup fails
and registered cleanup runs. Runtime exhaustion keeps API alive but gate
closed; same failed nonce cannot start another cycle for 30,000 ms. A changed
nonce or explicit `checkNow()` starts one new coalesced bounded cycle.

- [ ] **Step 3: Run focused tests and verify red**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/lib/browser-runtime/startup-gate.test.ts src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts src/lib/browser-runtime/reconciliation-coordinator.test.ts src/lib/browser-state/store.integration.test.ts src/lib/scrape-interact/replay-store.integration.test.ts src/services/local-retention-worker.test.ts
```

Expected: FAIL because gate, snapshot loader, and coordinator do not exist and
retention does not wait for reconciliation.

- [ ] **Step 4: Implement gate and repeatable-read authority loader**

Expose exact gate methods:

```ts
export type BrowserStartupBinding = {
  processNonce: string;
  snapshotDigest: string;
};

export type BrowserMutationDrain = {
  epoch: number;
  drained: Promise<void>;
};

export type BrowserStateMutationLease = {
  readonly epoch: number;
  readonly scope: "filesystem_and_database";
};

export type BrowserStartupGate = {
  assertOpen(): BrowserStartupBinding;
  close(reason: string): BrowserMutationDrain;
  open(drain: BrowserMutationDrain, binding: BrowserStartupBinding): void;
  waitUntilOpen(signal: AbortSignal): Promise<BrowserStartupBinding>;
  withBrowserStateMutationLease<T>(
    scope: "filesystem_and_database",
    operation: (lease: BrowserStateMutationLease) => Promise<T>,
  ): Promise<T>;
  withDrainedBrowserStateMutation<T>(
    drain: BrowserMutationDrain,
    operation: (lease: BrowserStateMutationLease) => Promise<T>,
  ): Promise<T>;
};

export function createBrowserStartupGate(): BrowserStartupGate;
```

Gate starts closed. `close()` synchronously makes later admission and mutation
leases fail, increments epoch, and returns one drain whose promise settles only
after every earlier lease releases. One lease covers filesystem side effect
and matching database compare-and-set as one mutation; lease registration is
synchronous before operation invocation and releases in `finally`. Never
acquire separate filesystem and database leases. `open()` accepts only current
drained epoch and
coordinator's validated nonce/digest binding; stale drains cannot reopen gate.
`withDrainedBrowserStateMutation()` accepts only current fully drained token,
runs coordinator recovery while admission remains closed, and resolves before
snapshot may start. It cannot overlap a normal lease or be called by routes.
Every later API mutator receives this gate as an explicit constructor or
function dependency. No browser-state filesystem or database mutator is
exported to controllers as an unleased callback. Read-only operations may use
`assertOpen()`; `assertOpen()` alone never authorizes a mutation.

Expose snapshot loader:

```ts
export type BrowserReconciliationSnapshot = {
  snapshotDigest: string;
  references: ReconciliationReferenceV1[];
};

export async function loadBrowserReconciliationSnapshot(
  pool: Pick<Pool, "connect">,
): Promise<BrowserReconciliationSnapshot>;
```

Open a read-only `REPEATABLE READ` transaction. Query all checkpoint rows where
`state_path IS NOT NULL AND file_deleted_at IS NULL`, all profile generations
under the same predicate, and every cleanup-intent row. Map only
`{kind,id,path: state_path,checksum}`. Sort by `kind`, `id`, and `path`, reject
invalid rows/caps/aliases, and compute the exact Task 1 digest before commit.
Rollback on any error. Never send owner, scrape, profile, session, latest,
active, database, or retention fields to Browser Service.

- [ ] **Step 5: Recover exact-process cleanup intents under the drain**

Export this one-shot recovery boundary from `local-retention-worker.ts` so it
reuses existing process-identity, advisory-lock, path-lock, current-path, and CAS
rules without starting retention loop:

```ts
export type CleanupIntentStartupRecoveryResult = {
  liveRetained: number;
  unknownRetained: number;
  deadRecovered: number;
  missingConverged: number;
};

export async function recoverBrowserCleanupIntentsBeforeSnapshot(
  deps: {
    pool: Pick<Pool, "connect">;
    filesystem: BrowserStateFilesystem;
    inspectProcessIdentity: typeof inspectBrowserStateProcessIdentity;
    signal: AbortSignal;
  },
): Promise<CleanupIntentStartupRecoveryResult>;
```

Call only inside `withDrainedBrowserStateMutation()` after current
`BrowserMutationDrain.drained` resolves and before snapshot transaction begins.
Select every `preparing` cleanup intent. Complete
writer identity `(pid, bootId, startTime)` is classified with
`inspectBrowserStateProcessIdentity`; retain `live` and `unknown` unchanged.
For `dead`, acquire same scrape/path advisory locks, reselect exact intent by
`id`, `state_path`, `checksum`, `state`, `writer_lease`, `writer_pid`,
`writer_boot_id`, and `writer_start_time`, and recheck current checkpoint path.
Delete noncurrent file; treat `ENOENT` as converged; then CAS-delete exact
intent. Current-path intent deletes only intent row. Lock/CAS mismatch retries
selection once inside same startup attempt; unexpected filesystem, database,
or advisory failure aborts reconciliation and leaves gate closed.

This function never calls `waitUntilOpen()`, starts retention, or acquires a
normal mutation lease: coordinator already owns closed, drained epoch. This
avoids deadlock while retention is paused. Snapshot then retains every live,
unknown, cleanup-state, or failed-recovery intent still present.

- [ ] **Step 6: Implement recovery-first reconciliation coordinator**

Expose one lifecycle object:

```ts
export type BrowserReconciliationRetryConfig = {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  startupBudgetMs: number;
  monitorIntervalMs: number;
  retryCooldownMs: number;
};

export type BrowserReconciliationCoordinatorDependencies = {
  gate: BrowserStartupGate;
  serviceClient: Pick<BrowserServiceClient,
    "getLive" | "getReady" | "reconcile">;
  loadSnapshot: typeof loadBrowserReconciliationSnapshot;
  interruptUnfinishedBrowserWork: typeof interruptUnfinishedBrowserWork;
  recoverBrowserCleanupIntentsBeforeSnapshot:
    typeof recoverBrowserCleanupIntentsBeforeSnapshot;
  pauseBrowserRetention: () => Promise<void>;
  startBrowserRetention: () => Promise<void>;
  retry: BrowserReconciliationRetryConfig;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  logger: Pick<Logger, "info" | "error">;
};

export type BrowserReconciliationCoordinator = {
  initialize(signal?: AbortSignal): Promise<BrowserStartupBinding>;
  checkNow(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
};

export function createBrowserReconciliationCoordinator(
  deps: BrowserReconciliationCoordinatorDependencies,
): BrowserReconciliationCoordinator;
```

`BrowserReconciliationCoordinatorDependencies` requires `gate`, `serviceClient`,
`loadSnapshot`, `interruptUnfinishedBrowserWork`,
`recoverBrowserCleanupIntentsBeforeSnapshot`, `startBrowserRetention`,
`pauseBrowserRetention`, clock/timer hooks, logger, and exact Task 7 retry
configuration. No harness callback owns recovery or retention.

`initialize()` requires migrations already applied. Under one mutex: call
`gate.close()`, pause browser-state retention, await returned `drained`, then call
`gate.withDrainedBrowserStateMutation(drain, ...)` once around
`interruptUnfinishedBrowserWork(now)` and exact-process cleanup-intent
recovery. After that wrapper resolves, read authenticated live nonce and capture
the repeatable-read snapshot, post `{version:1, processNonce, snapshotDigest,
references}`, validate the closed result, fetch ready health, and require both
responses equal requested nonce/digest. Then `gate.open(drain, binding)` and
start browser-state retention. Each request deadline is the smaller of its
configured timeout and the remaining 60,000 ms startup budget.

`checkNow()` fetches ready health. Any 503, changed nonce, changed digest,
transport/auth/schema error, or process restart closes gate immediately and
runs the same recovery sequence. Concurrent detections share one promise. Old
runtime sessions, model threads, actions, grants, and Chromium processes are
interrupted, never resumed. One cycle has at most 4 attempts. Attempt 1 starts
immediately; attempts 2..4 wait 250, 500, and 1,000 ms, each capped by remaining
60,000 ms cycle budget. Startup exhaustion rejects initialization and API
startup cleanup runs. Runtime exhaustion leaves gate closed, pauses retention,
records failed nonce, and suppresses same-nonce automatic retry for 30,000 ms;
nonce change or explicit `checkNow()` may start one new coalesced cycle. No
cloud/stateless fallback.

Split the existing API-owned local retention loop into two explicit phases:
`runOperationalAndArtifactRetentionIteration()` and
`runBrowserStateRetentionIteration()`. `index.ts` constructs exactly one
retention service for every local-persistence API process, regardless of
`LOCAL_BROWSER_SERVICE_ENABLED`. It starts operational database/run cleanup
and local artifact retention immediately after migrations. These phases never
wait on browser reconciliation and continue during Browser Service outage or
restart. No Browser Service process or harness parent runs them.

When the browser feature is enabled, the same service registers its browser
state phase with the coordinator. That phase waits on `waitUntilOpen(signal)`
before every iteration and pauses/drains on gate close. When disabled, do not
schedule browser-state recovery or retention; the one API retention service
still runs the non-browser phases exactly once per interval. Shutdown stops
coordinator/monitor first when present, then the single retention service,
then database. Tests use call counts to reject duplicate timers/owners.

Wrap browser-state file creation, profile publication/discard, checkpoint
materialization/cleanup, and retention deletion in
`gate.withBrowserStateMutationLease("filesystem_and_database", ...)`. Make the
browser phase call `waitUntilOpen(signal)` before each iteration. `index.ts`
starts coordinator after migrations and before browser routes admit work.

This gate is mandatory dependency for later mutation boundaries: Task 9
session/profile/run create, attach, transition, and stop; Task 10 action and
capability state; Task 11 grants and artifact manifest/run attachment; Tasks
12-13 controller-facing operations. Each later task adds its race tests. No
constructor accepts an optional gate, and no enabled-local-mode test may use a
pass-through mutation executor.

- [ ] **Step 7: Run integration tests serially and build**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/lib/browser-runtime/startup-gate.test.ts src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts src/lib/browser-runtime/reconciliation-coordinator.test.ts src/lib/browser-state/store.integration.test.ts src/lib/scrape-interact/replay-store.integration.test.ts src/services/local-retention-worker.test.ts
pnpm --dir apps/api build
```

Expected: tests PASS with one shared-schema worker; build PASS. Snapshot,
recovery, gate, retention, restart, retry, and redaction order are locked.

- [ ] **Step 8: Commit API startup reconciliation**

```bash
git add apps/api/src/lib/browser-runtime/startup-gate.ts apps/api/src/lib/browser-runtime/startup-gate.test.ts apps/api/src/lib/browser-runtime/reconciliation-snapshot.ts apps/api/src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts apps/api/src/lib/browser-runtime/reconciliation-coordinator.test.ts apps/api/src/lib/browser-state/store.ts apps/api/src/lib/browser-state/store.integration.test.ts apps/api/src/lib/browser-state/filesystem-store.ts apps/api/src/lib/scrape-interact/replay-store.ts apps/api/src/lib/scrape-interact/replay-store.integration.test.ts apps/api/src/services/local-retention-worker.ts apps/api/src/services/local-retention-worker.test.ts apps/api/src/index.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: gate browser startup on reconciliation" -m "Recover durable work and reconcile one repeatable-read state snapshot
before opening browser work or browser-state retention.

Close admission and coalesce reconciliation when service nonce changes."
```

### Task 9: Define one-job execution boundary and session orchestrator

**Files:**
- Create: `apps/api/src/lib/browser-runtime/protocol.ts`
- Create: `apps/api/src/lib/browser-runtime/protocol.test.ts`
- Create: `apps/api/src/lib/browser-runtime/execution-adapter.ts`
- Create: `apps/api/src/lib/browser-runtime/execution-adapter.test.ts`
- Create: `apps/api/src/lib/browser-runtime/orchestrator.ts`
- Create: `apps/api/src/lib/browser-runtime/orchestrator.test.ts`
- Modify: `apps/api/src/lib/browser-state/types.ts`
- Modify: `apps/api/src/lib/browser-state/store.ts`

- [ ] **Step 1: Write adapter and orchestration tests**

```ts
it("submits one outer prompt job with locked loop policy", async () => {
  await orchestrator.executePrompt(interactInput);
  expect(adapter.executePromptRun).toHaveBeenCalledTimes(1);
  expect(adapter.executePromptRun).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      decisionSchemaVersion: 1,
      observationSchemaVersion: 1,
      loopPolicy: EXPECTED_PROMPT_LOOP_POLICY,
    }),
    expect.any(AbortSignal),
  );
});

it("fails closed when host execution is absent", async () => {
  await expect(unavailableExecutionAdapter.executePromptRun(promptInput, signal))
    .rejects.toMatchObject({ category: "codex_unavailable" });
});

it("stop elects one cleanup owner", async () => {
  await Promise.all([
    orchestrator.stopSession(sessionId, "requested"),
    orchestrator.stopSession(sessionId, "requested"),
  ]);
  expect(adapter.cancelExecutionRun).toHaveBeenCalledTimes(1);
  expect(browserClient.closeSession).toHaveBeenCalledTimes(1);
});

it("rejects runtime creation while startup reconciliation is closed", async () => {
  startupGate.close("service_restart");
  await expect(orchestrator.createDirectSession(input)).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  expect(browserClient.createSession).not.toHaveBeenCalled();
  expect(createDurableSession).not.toHaveBeenCalled();
});

it("drains an in-flight session transaction and rejects the next create", async () => {
  createDurableSession.pauseAfterInsert();
  const create = orchestrator.createDirectSession(input);
  await createDurableSession.reachedPause();
  const drain = startupGate.close("service_restart");
  expect(await promiseState(drain.drained)).toBe("pending");
  await expect(orchestrator.createDirectSession(input)).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  createDurableSession.release();
  await create;
  await drain.drained;
  expect(events).toEqual([
    "session:insert",
    "gate:close",
    "session:commit",
    "mutations:drained",
  ]);
});

it("does not hold mutation lease across host execution", async () => {
  adapter.executePromptRun.mockReturnValue(hostResult.promise);
  const execution = orchestrator.executePrompt(interactInput);
  await adapterStarted();
  const drain = startupGate.close("service_restart");
  await expect(drain.drained).resolves.toBeUndefined();
  hostResult.reject(new Error("interrupted"));
  await expect(execution).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
});

it("separates strict model wire operations from trusted internal operations", () => {
  const missingRef = {
    decision: {
      version: 1, type: "action", action: { kind: "get_text" },
    },
  };
  const nullableRef = {
    decision: {
      version: 1, type: "action",
      action: { kind: "get_text", ref: null },
    },
  };
  const nonemptyWireArgs = {
    decision: {
      version: 1, type: "action",
      action: { kind: "evaluate", expression: "x", args: { x: 1 } },
    },
  };
  const emptyWireArgs = {
    decision: {
      version: 1, type: "action",
      action: { kind: "evaluate", expression: "1", args: {} },
    },
  };

  expect(modelDecisionEnvelopeV1Schema.safeParse(missingRef).success).toBe(false);
  expect(modelDecisionEnvelopeV1Schema.safeParse(nullableRef).success).toBe(true);
  expect(modelDecisionEnvelopeV1Schema.safeParse(nonemptyWireArgs).success)
    .toBe(false);
  expect(normalizeModelDecisionEnvelopeV1(emptyWireArgs)).toEqual({
    version: 1, type: "action",
    action: { kind: "evaluate", expression: "1", args: {} },
  });
  expect(normalizeModelDecisionEnvelopeV1(nullableRef)).toEqual({
    version: 1, type: "action", action: { kind: "get_text" },
  });
  expect(browserOperationSchema.safeParse({ kind: "get_text" }).success)
    .toBe(true);
  expect(browserOperationSchema.safeParse({
    kind: "evaluate", expression: "x", args: { x: 1 },
  }).success).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-runtime/protocol.test.ts src/lib/browser-runtime/execution-adapter.test.ts src/lib/browser-runtime/orchestrator.test.ts
```

Expected: FAIL because execution boundary and orchestrator do not exist.

- [ ] **Step 3: Define exact prompt/code adapter types**

In `browser-state/types.ts`, define `ObservationV1.result` through a type-only
re-export of the API-owned Task 7 schema inference:

```ts
import type { BrowserOperationResultV1 } from
  "../scrape-interact/browser-service-contracts";
export type { BrowserOperationResultV1 };
```

Use this type for durable action rows, service results, and observations; do
not add another result shape.

```ts
import { z } from "zod";
import type {
  BrowserOperation,
  BrowserOperationResultV1,
} from "../browser-state/types";

const internalRefSchema = z.string().min(1).max(128);
const internalTextSchema = z.string().max(20_000);
const internalJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(internalJsonValueSchema),
  z.record(z.string(), internalJsonValueSchema),
]));

export const browserOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot") }).strict(),
  z.object({ kind: z.literal("click"), ref: internalRefSchema }).strict(),
  z.object({
    kind: z.literal("fill"), ref: internalRefSchema,
    value: internalTextSchema,
  }).strict(),
  z.object({
    kind: z.literal("type"), ref: internalRefSchema,
    value: internalTextSchema,
    delayMs: z.number().int().min(0).max(250),
  }).strict(),
  z.object({
    kind: z.literal("press"), ref: internalRefSchema,
    key: z.string().min(1).max(64),
  }).strict(),
  z.object({
    kind: z.literal("select"), ref: internalRefSchema,
    values: z.array(z.string().max(512)).max(20),
  }).strict(),
  z.object({
    kind: z.literal("scroll"),
    deltaX: z.number().int().min(-10_000).max(10_000),
    deltaY: z.number().int().min(-10_000).max(10_000),
  }).strict(),
  z.object({
    kind: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(30_000),
  }).strict(),
  z.object({
    kind: z.literal("get_text"), ref: internalRefSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("get_url") }).strict(),
  z.object({
    kind: z.literal("navigate"), url: z.string().url().max(8_192),
  }).strict(),
  z.object({
    kind: z.literal("evaluate"), expression: internalTextSchema,
    args: z.record(z.string(), internalJsonValueSchema),
  }).strict(),
]);

export type BoundedPageState = {
  url: string;
  title: string;
  snapshotExcerpt: string;
};

export type ObservationV1 =
  | {
      version: 1;
      type: "initial";
      sequence: 0;
      page: BoundedPageState;
    }
  | {
      version: 1;
      type: "action_result";
      sequence: number;
      actionId: string;
      actionKind: BrowserOperation["kind"];
      outcome: "succeeded" | "rejected_no_effect" | "failed_no_effect";
      result?: BrowserOperationResultV1;
      error?: { category: string; message: string };
      page: BoundedPageState;
    };

export type ModelDecisionV1 =
  | { version: 1; type: "action"; action: BrowserOperation }
  | { version: 1; type: "final"; output: string };

export type ModelWireBrowserOperationV1 =
  | { kind: "snapshot" }
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "type"; ref: string; value: string; delayMs: number }
  | { kind: "press"; ref: string; key: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "wait"; milliseconds: number }
  | { kind: "get_text"; ref: string | null }
  | { kind: "get_url" }
  | { kind: "navigate"; url: string }
  | {
      kind: "evaluate";
      expression: string;
      args: Record<string, never>;
    };

export type ModelWireDecisionV1 =
  | { version: 1; type: "action"; action: ModelWireBrowserOperationV1 }
  | { version: 1; type: "final"; output: string };

export interface ModelDecisionEnvelopeV1 {
  decision: ModelWireDecisionV1;
}

// Internal API/Browser Service validation. Never use this for raw model output.
export const modelDecisionV1Schema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("action"),
    action: browserOperationSchema,
  }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("final"),
    output: z.string().max(256 * 1024),
  }).strict(),
]);

const modelWireRefSchema = z.string().min(1).max(128);
const modelWireTextSchema = z.string().max(20_000);
const emptyModelWireArgsSchema = z.object({}).strict()
  .transform((): Record<string, never> => ({}));

export const modelWireBrowserOperationV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot") }).strict(),
  z.object({ kind: z.literal("click"), ref: modelWireRefSchema }).strict(),
  z.object({
    kind: z.literal("fill"),
    ref: modelWireRefSchema,
    value: modelWireTextSchema,
  }).strict(),
  z.object({
    kind: z.literal("type"),
    ref: modelWireRefSchema,
    value: modelWireTextSchema,
    delayMs: z.number().int().min(0).max(250),
  }).strict(),
  z.object({
    kind: z.literal("press"),
    ref: modelWireRefSchema,
    key: z.string().min(1).max(64),
  }).strict(),
  z.object({
    kind: z.literal("select"),
    ref: modelWireRefSchema,
    values: z.array(z.string().max(512)).max(20),
  }).strict(),
  z.object({
    kind: z.literal("scroll"),
    deltaX: z.number().int().min(-10_000).max(10_000),
    deltaY: z.number().int().min(-10_000).max(10_000),
  }).strict(),
  z.object({
    kind: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(30_000),
  }).strict(),
  z.object({
    kind: z.literal("get_text"),
    ref: modelWireRefSchema.nullable(),
  }).strict(),
  z.object({ kind: z.literal("get_url") }).strict(),
  z.object({
    kind: z.literal("navigate"),
    url: z.string().url().max(8_192),
  }).strict(),
  z.object({
    kind: z.literal("evaluate"),
    expression: modelWireTextSchema,
    args: emptyModelWireArgsSchema,
  }).strict(),
]);

export const modelWireDecisionV1Schema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("action"),
    action: modelWireBrowserOperationV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("final"),
    output: z.string().max(256 * 1024),
  }).strict(),
]);

export const modelDecisionEnvelopeV1Schema = z.object({
  decision: modelWireDecisionV1Schema,
}).strict();

function normalizeModelWireBrowserOperationV1(
  operation: ModelWireBrowserOperationV1,
): BrowserOperation {
  switch (operation.kind) {
    case "snapshot": return { kind: "snapshot" };
    case "click": return { kind: "click", ref: operation.ref };
    case "fill": return {
      kind: "fill", ref: operation.ref, value: operation.value,
    };
    case "type": return {
      kind: "type", ref: operation.ref, value: operation.value,
      delayMs: operation.delayMs,
    };
    case "press": return {
      kind: "press", ref: operation.ref, key: operation.key,
    };
    case "select": return {
      kind: "select", ref: operation.ref, values: [...operation.values],
    };
    case "scroll": return {
      kind: "scroll", deltaX: operation.deltaX, deltaY: operation.deltaY,
    };
    case "wait": return {
      kind: "wait", milliseconds: operation.milliseconds,
    };
    case "get_text": return operation.ref === null
      ? { kind: "get_text" }
      : { kind: "get_text", ref: operation.ref };
    case "get_url": return { kind: "get_url" };
    case "navigate": return { kind: "navigate", url: operation.url };
    case "evaluate": return {
      kind: "evaluate", expression: operation.expression, args: {},
    };
  }
  const unreachableOperation: never = operation;
  throw new TypeError(`unsupported model wire operation: ${unreachableOperation}`);
}

export function normalizeModelDecisionEnvelopeV1(
  envelope: unknown,
): ModelDecisionV1 {
  const parsed = modelDecisionEnvelopeV1Schema.parse(envelope);
  const decision: ModelWireDecisionV1 = parsed.decision;
  return decision.type === "final"
    ? { version: 1, type: "final", output: decision.output }
    : {
        version: 1,
        type: "action",
        action: normalizeModelWireBrowserOperationV1(decision.action),
      };
}

export const PROMPT_LOOP_POLICY_V1 = {
  maxPromptCharacters: 10_000,
  maxSnapshotExcerptCharacters: 40_000,
  maxObservationBytes: 64 * 1024,
  maxAggregateObservationBytes: 1024 * 1024,
  maxFinalOutputBytes: 256 * 1024,
  maxActions: 25,
  maxTurns: 26,
  maxRuntimeMs: 300_000,
} as const;

export type PromptRunInput = {
  runId: string;
  adapterJobId: string;
  prompt: string;
  initialObservation: ObservationV1 & { type: "initial"; sequence: 0 };
  model: "gpt-5.6-terra";
  reasoningEffort: "medium";
  decisionSchemaVersion: 1;
  observationSchemaVersion: 1;
  loopPolicy: typeof PROMPT_LOOP_POLICY_V1;
  deadline: Date;
  correlationId: string;
};

export type PromptRunResult = {
  output: string;
  turnCount: number;
  actionCount: number;
  usage: { inputTokens: number; outputTokens: number };
  protocol: {
    toolEventCount: number;
    approvalEventCount: number;
    decisionSchemaVersion: 1;
    observationSchemaVersion: 1;
  };
};
```

`protocol.ts` owns both internal and model-wire schemas; import the canonical
`BrowserOperation` type from `../browser-state/types`. Internal
`browserOperationSchema` and `modelDecisionV1Schema` remain the API/Browser
Service validators. Raw model output uses only
`modelWireBrowserOperationV1Schema`, `modelWireDecisionV1Schema`, and
`modelDecisionEnvelopeV1Schema`; none may reuse an internal operation or
decision schema.

Zod `.literal()` remains the runtime validator and type representation; it is
not the checked-in Structured Outputs JSON Schema. Any emitted or mirrored
model-wire JSON Schema fixture must encode each fixed version/type/kind as a
typed one-value `enum` and recursively reject bare `const` or an enum missing
`type`. `protocol.test.ts` locks that rule for any JSON Schema fixture it owns.

Reject unknown fields, omitted or non-nullable wire `get_text.ref`, nonempty
wire `evaluate.args`, a missing/extra envelope field, malformed unions,
flattened nullable action/output supersets, both result and error, neither
result nor error for its outcome, excerpt over 40,000 characters, encoded
observation over 64 KiB, and final output over 256 KiB.
`normalizeModelDecisionEnvelopeV1` validates wire input first, maps a null text
ref to internal omission, retains empty evaluate args as `{}`, and returns
unchanged internal `ModelDecisionV1`. Envelope/schema/semantic mismatches map
to `model_protocol_error`. `protocol.test.ts` locks every wire variant, both
normalization special cases, all rejections, and proves internal evaluate args
remain available to trusted API/Browser Service callers. `PromptRunInput`,
`PromptRunResult`, action callbacks, ledger rows, and observations retain their
existing shapes except that every action result now uses the strict bounded
`BrowserOperationResultV1` from Locked private contracts. Protocol tests reject
wrong kind/result pairs, cyclic/unsupported JSON-safe values, every bound
overflow, and encoded observations over 64 KiB.

Keep `CodeRunInput` restricted to run ID, language, source, deadline, and
correlation ID. The public request cannot set model, effort, policy/schema
versions, callback URL, endpoint, token, command, mount, environment, or
network. The unavailable adapter throws typed 503 categories.

- [ ] **Step 4: Implement durable session create, replay, and stop**

Inject `BrowserStartupGate`; never use one-time `assertOpen()` to authorize a
mutation. Wrap each atomic setup segment in
`withBrowserStateMutationLease("filesystem_and_database", ...)`: durable
session/profile-writer creation; Browser Service create plus runtime attach;
replay checkpoint/profile materialization plus state transition; and rollback
of each exact resource. A closed gate returns sanitized
`browser_state_unavailable`. Create durable session before Browser Service
runtime, transition through `replaying` to `ready`, and roll back exact
resources on failure. Direct
sessions default 600/300; Interact uses 3600/600 and reserves that lifetime.

Prompt execution uses short leases for run/capability creation and the
session/run executing transition, then releases every lease before obtaining
initial observation and calling `executePromptRun` once. Never hold a mutation
lease across the up-to-300-second host job. Action callbacks take their own
Task 10 leases. After host return, acquire fresh leases for validated output,
usage/count persistence, capability revocation, and terminal run/session
transitions. Validate output
<=256 KiB, `turnCount <= 26`, `actionCount <= 25`, zero tool/approval counts,
and counts equal durable action ledger totals before success. Revoke capability
in `finally`. Persist sanitized usage/counts and terminal state.

Stop uses one short lease to claim cleanup owner, releases it while cancelling
adapter, then uses bounded leases for capability/grant revocation, Browser
Service close plus prepared-generation capture, profile finalize/pointer CAS,
and terminal result. A failed generation
database commit leaves prior pointer authoritative and discards that exact
orphan best-effort. Service failure still leaves durable terminal state.

- [ ] **Step 5: Run orchestration tests**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-runtime/protocol.test.ts src/lib/browser-runtime/execution-adapter.test.ts src/lib/browser-runtime/orchestrator.test.ts
```

Expected: PASS for create rollback, profile lock, replay failure, one outer
prompt call, exact loop policy, count verification, duplicate stop,
execution/stop/reconciliation races, mutation drain, no host-held lease,
profile crash boundaries, and unavailable adapters.

- [ ] **Step 6: Commit orchestration boundary**

```bash
git add apps/api/src/lib/browser-runtime/protocol.ts apps/api/src/lib/browser-runtime/protocol.test.ts apps/api/src/lib/browser-runtime/execution-adapter.ts apps/api/src/lib/browser-runtime/execution-adapter.test.ts apps/api/src/lib/browser-runtime/orchestrator.ts apps/api/src/lib/browser-runtime/orchestrator.test.ts apps/api/src/lib/browser-state/types.ts apps/api/src/lib/browser-state/store.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: coordinate local browser runs" -m "Create and stop durable browser sessions around one outer host adapter
job with locked model, schema, observation, action, and turn policy.

Verify adapter counts against durable state before prompt completion."
```

### Task 10: Add durable host action callback and execute-once coordinator

**Files:**
- Create: `apps/api/src/lib/browser-runtime/action-normalization.ts`
- Create: `apps/api/src/lib/browser-runtime/action-normalization.test.ts`
- Create: `apps/api/src/lib/browser-runtime/action-coordinator.ts`
- Create: `apps/api/src/lib/browser-runtime/action-coordinator.test.ts`
- Create: `apps/api/src/lib/browser-state/capability-store.ts`
- Create: `apps/api/src/lib/browser-state/capability-store.test.ts`
- Create: `apps/api/src/controllers/internal/browser-runs.ts`
- Create: `apps/api/src/controllers/internal/browser-runs.test.ts`
- Create: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/browser-state/store.ts`

- [ ] **Step 1: Write action-state and callback-replay tests**

```ts
it("persists prepared before one Browser Service dispatch", async () => {
  await coordinator.handleProposal(activeRun, proposal, context);
  expect(events).toEqual([
    "insert:prepared",
    "authorize",
    "transition:executing",
    "service:executeAction",
    "transition:succeeded",
  ]);
  expect(browserClient.executeAction).toHaveBeenCalledTimes(1);
});

it("returns known matching callback replay without redispatch", async () => {
  const first = await coordinator.handleProposal(activeRun, proposal, context);
  const replay = await coordinator.handleProposal(activeRun, proposal, context);
  expect(replay).toEqual(first);
  expect(browserClient.executeAction).toHaveBeenCalledTimes(1);
});

it("terminates run and session for unresolved executing outcome", async () => {
  browserClient.executeAction.mockRejectedValue(new TransportClosedError());
  await expect(coordinator.handleProposal(activeRun, proposal, context))
    .rejects.toMatchObject({ category: "action_outcome_unknown" });
  expect(await actionState(proposal.actionId)).toBe("outcome_unknown");
  expect(await runState(activeRun.id)).toBe("failed");
  expect(await sessionState(activeRun.sessionId)).toBe("error");
});

it("recovers executing action when gate closes before dispatch lease", async () => {
  pauseAfterMarkExecuting();
  const callback = coordinator.handleProposal(activeRun, proposal, context);
  await reachedExecutingPause();
  const drain = startupGate.close("service_restart");
  releaseExecutingPause();
  await expect(callback).rejects.toMatchObject({
    category: "action_outcome_unknown",
  });
  expect(browserClient.executeAction).not.toHaveBeenCalled();
  await drain.drained;
  await runStartupRecovery(drain);
  expect(await actionState(proposal.actionId)).toBe("outcome_unknown");
});

it("drains in-flight callback mutation and rejects new capability issue", async () => {
  completeBrowserAction.pauseBeforeCommit();
  const callback = coordinator.handleProposal(activeRun, proposal, context);
  await completeBrowserAction.reachedPause();
  const drain = startupGate.close("service_restart");
  expect(await promiseState(drain.drained)).toBe("pending");
  await expect(capabilities.issue(input)).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  completeBrowserAction.release();
  await callback;
  await drain.drained;
});

it("marks unsafe service output outcome unknown and never caches it", async () => {
  browserClient.executeAction.mockRejectedValueOnce(
    new BrowserServiceProtocolError("invalid bounded action result"),
  );
  await expect(coordinator.handleProposal(activeRun, evaluateProposal, context))
    .rejects.toMatchObject({ category: "action_outcome_unknown" });
  expect(await actionState(evaluateProposal.actionId)).toBe("outcome_unknown");
  expect(await actionResult(evaluateProposal.actionId)).toBeNull();
  expect(await runState(activeRun.id)).toBe("failed");
  expect(await sessionState(activeRun.sessionId)).toBe("error");
});

it("persists only a validated bounded operation result", async () => {
  browserClient.executeAction.mockResolvedValueOnce(validGetTextResult);
  const observation = await coordinator.handleProposal(
    activeRun, getTextProposal, context,
  );
  expect(observation.result).toEqual({ kind: "get_text", text: "bounded" });
  expect(encodedBytes(observation)).toBeLessThanOrEqual(64 * 1024);
  expect(await storedActionResult(getTextProposal.actionId))
    .toEqual(observation.result);
});
```

Add tests for `prepared -> rejected_no_effect`, Browser Service proven
`failed_no_effect`, pre-dispatch cancellation, same sequence/different hash,
same action ID/different hash, duplicate side-effect hash after definite
failure, repeated read-only hash, action 26, expired capability, owner/session/
run/job/process mismatch, callback cancellation, wrong result discriminant,
cyclic/undefined/symbol/bigint/non-finite values, 40,000-character `get_text`,
32 KiB evaluate, 64 KiB result, 128 KiB service response, and 64 KiB
observation boundaries. For every overflow/serialization failure after
dispatch, assert `outcome_unknown`, no result cache, capability revocation,
and terminal run/session.

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-runtime/action-normalization.test.ts src/lib/browser-runtime/action-coordinator.test.ts src/lib/browser-state/capability-store.test.ts src/controllers/internal/browser-runs.test.ts
```

Expected: FAIL because normalization, coordinator, capability store, and
callback route do not exist.

- [ ] **Step 3: Implement canonical hash and trusted effect classification**

Serialize operation with recursively sorted object keys, exact JSON string/
number/boolean/null values, and no undefined/non-JSON values. Hash UTF-8 bytes
with SHA-256. Classify `snapshot`, `get_text`, `get_url`, and `wait` as
`read_only`; classify click, fill, type, press, select, scroll, navigate, and
evaluate as `side_effecting`. API recomputes both values and rejects an adapter
mismatch as `model_protocol_error`.

Use the prerequisite `SubmitBrowserActionV1` type and define an exact strict
Zod schema for it. Do not introduce a renamed callback type.

`adapterJobId` and `actionId` are UUIDs, `sequence` is 1..25, and
`proposalHash` is lowercase SHA-256. The API recomputes the normalized hash
and sends it to Browser Service as `normalizedProposalHash`. The callback body
accepts no owner, session, capability, model, endpoint, URL grant, command,
path, environment, mount, or idempotency override.

- [ ] **Step 4: Add transactional action and capability helpers**

Consume the prerequisite action-store exports unchanged:

```ts
prepareBrowserAction(runId, request): Promise<PrepareBrowserActionResult>;
markBrowserActionExecuting(runId, actionId): Promise<BrowserInteractActionRow>;
completeBrowserAction(input): Promise<ObservationV1>;
getBrowserActionByIdentity(runId, actionId, sequence): Promise<BrowserInteractActionRow | null>;
interruptUnfinishedBrowserWork(now): Promise<BrowserRecoveryResult>;
```

Add only these coordinator query helpers:

```ts
countInteractActions(runId): Promise<number>;
findSideEffectingActionByHash(runId, normalizedProposalHash): Promise<BrowserInteractActionRow | null>;
```

`prepareBrowserAction` already atomically enforces one in-flight action,
sequence monotonicity, action cap 25, identity/hash uniqueness, and stores the
exact typed operation plus effect. Extend it only where coordinator tests
prove a missing policy check. Capability issue stores only token hash and
server-side owner/session/run/adapter-job/supervisor bindings, operations,
origins, navigation version, byte/call/action limits, wall/per-operation
deadlines, and timestamps. Redemption never returns a raw token and is
available only to the coordinator.

Inject `BrowserStartupGate` into action and capability stores. Wrap each
`prepareBrowserAction`, policy/capability redemption, `mark...Executing`,
`completeBrowserAction`, capability issue/redeem/revoke, and terminal
run/session transition in
`withBrowserStateMutationLease("filesystem_and_database", ...)`. Reads may use
`assertOpen()`, but no write follows a bare assertion. Startup action recovery
runs only inside Task 8 `withDrainedBrowserStateMutation()`.

- [ ] **Step 5: Implement coordinator state machine**

For a new structurally valid proposal:

1. Load active prompt run/session, require its adapter job to equal
   `adapterJobId`, and recompute hash/effect.
2. Under one short mutation lease, persist `prepared`, authorize/redeem
   capability, and persist `rejected_no_effect` for policy denial. Prepared
   consumes one action budget even if policy rejects.
3. Under a second short lease, revalidate gate/capability and transition
   `prepared -> executing`; release it before dispatch acquisition.
4. Acquire a third mutation lease immediately before one
   `browserClient.executeAction()` call. Hold this bounded per-operation lease
   through service result validation and `succeeded`/`failed_no_effect`
   completion, then return matching observation. Parse operation-specific
   `BrowserOperationResultV1`, enforce 64 KiB result, 128 KiB service response,
   and 64 KiB observation before persisting any result.
5. If gate closes after `executing` but before third lease, do not dispatch.
   Return `action_outcome_unknown`; drained startup recovery marks action/run/
   session terminal. This conservative state is required even though no effect
   was observed, because dispatch boundary was not durably proven.
6. If result cannot be proven after dispatch, persist under current lease or
   drained recovery as
   `outcome_unknown`, revoke capability, terminate run and browser session,
   and throw `action_outcome_unknown`. Never send that outcome to Codex.

Malformed discriminants, cyclic/unsupported JSON-safe values, non-finite
numbers, and any result/response/observation serialization or size failure
after dispatch follow step 6. Evaluate is always potentially mutating even if
its value serialization alone failed. These cases must never become
`failed_no_effect` and must never populate service or API replay caches.

Callback replay with matching identity/hash returns stored `succeeded`,
`rejected_no_effect`, or `failed_no_effect` observation. A matching
`cancelled_no_effect` returns terminal cancellation. An unresolved
`executing` replay becomes `outcome_unknown`. Any identity/sequence hash
mismatch is `model_protocol_error`. Never dispatch on replay.

Reject a repeated side-effecting normalized hash even after definite no
effect; Codex must choose a materially different action. Repeated read-only
operations remain allowed. Do not automatically retry any action.

Keep coordinator dependency
`interruptUnfinishedBrowserWork(now): Promise<BrowserRecoveryResult>` exact.
Extend that exported store transaction to resolve every stale `prepared`
action as `cancelled_no_effect` and every stale `executing` action as
`outcome_unknown`, then terminate affected run/session and revoke capability.
Task 8 coordinator already invokes this dependency inside
`withDrainedBrowserStateMutation()` before cleanup-intent recovery/snapshot.
Do not add another startup callback,
resume adapter job/model thread/action ledger, or change recovery ordering.
Preserve action rows for audit.

- [ ] **Step 6: Mount authenticated callbacks and exact error map**

Mount:

```text
POST /internal/browser-runs/:runId/actions
WS   /internal/browser-runs/:runId/cdp
POST /internal/browser-runs/:runId/artifacts
```

Authenticate the boot-scoped adapter token from
`BROWSER_ADAPTER_TOKEN_FILE` with constant-time hash comparison. Resolve
server-held run authority. The action endpoint parses
`SubmitBrowserActionV1`, invokes the coordinator, and returns only strict
`ObservationV1` with 64 KiB total and 40,000-character excerpt limits. This is
an authenticated host action callback, not an MCP or Codex browser relay.

Map `model_protocol_error -> 502`, `action_limit_exceeded -> 429`,
`action_outcome_unknown -> 502` plus terminal session,
`capability_denied|target_blocked -> 403`, `concurrency_exceeded -> 429`,
`browser_state_unavailable|browser_unavailable|codex_unavailable|
sandbox_unavailable|model_unavailable -> 503`, and
`deadline_exceeded -> 504`. Preserve existing cancellation,
404, 409, and 410 semantics. Sanitize messages.

- [ ] **Step 7: Run coordinator and callback tests**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-runtime/action-normalization.test.ts src/lib/browser-runtime/action-coordinator.test.ts src/lib/browser-state/capability-store.test.ts src/controllers/internal/browser-runs.test.ts
```

Expected: PASS for every action transition, prepare-before-dispatch,
execute-once, matching replay, mismatch, no-effect continuation, duplicate
side-effect rejection, repeated read-only operations, cap, deadline,
cancellation, strict result validation/bounds, serialization ambiguity without
caching, unknown outcome termination, recovery, and redaction.

- [ ] **Step 8: Commit action coordinator**

```bash
git add apps/api/src/lib/browser-runtime/action-normalization.ts apps/api/src/lib/browser-runtime/action-normalization.test.ts apps/api/src/lib/browser-runtime/action-coordinator.ts apps/api/src/lib/browser-runtime/action-coordinator.test.ts apps/api/src/lib/browser-state/capability-store.ts apps/api/src/lib/browser-state/capability-store.test.ts apps/api/src/controllers/internal/browser-runs.ts apps/api/src/controllers/internal/browser-runs.test.ts apps/api/src/routes/internal.ts apps/api/src/index.ts apps/api/src/lib/browser-state/store.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: coordinate browser actions durably" -m "Persist every model action before dispatch, authorize it through
server-held capability policy, and execute it at most once.

Cache known callback results, reject identity mismatches, and terminate
ambiguous outcomes."
```

### Task 11: Add proxy grants and bounded browser artifacts

**Files:**
- Create: `apps/api/src/lib/browser-state/proxy-grant-store.ts`
- Create: `apps/api/src/lib/browser-state/proxy-grant-store.test.ts`
- Create: `apps/api/src/lib/browser-runtime/proxy-urls.ts`
- Create: `apps/api/src/lib/browser-runtime/proxy-urls.test.ts`
- Create: `apps/api/src/lib/browser-runtime/artifacts.ts`
- Create: `apps/api/src/lib/browser-runtime/artifacts.test.ts`
- Modify: `apps/api/src/lib/artifacts/manifest.ts`
- Modify: `apps/api/src/lib/artifacts/local-manifest.ts`
- Modify: `apps/api/src/controllers/internal/browser-runs.ts`

- [ ] **Step 1: Write grant and artifact tests**

Assert raw grants return only once; database stores SHA-256; redeem is atomic;
passive cannot become interactive/CDP; stop revokes all grants; artifact IDs,
headers, lengths, checksums, owner/run/session bindings, ZDR, item/run budgets,
and disconnect cleanup fail closed.

```ts
it("stores only a grant hash and redeems once", async () => {
  const issued = await issueBrowserProxyGrant(validGrantInput);
  expect(await rawGrantTokenInDatabase(issued.id)).toBeNull();
  expect(await redeemBrowserProxyGrant(issued.token, "passive")).not.toBeNull();
  expect(await redeemBrowserProxyGrant(issued.token, "passive")).toBeNull();
});

it("rejects artifact bytes that differ from declared hash", async () => {
  await expect(ingestBrowserArtifact(activeRun, {
    ...validArtifactHeaders, sha256: "0".repeat(64),
  }, pngBytes)).rejects.toMatchObject({
    category: "artifact_checksum_mismatch",
  });
  expect(attachRunArtifact).not.toHaveBeenCalled();
});

it("drains grant redemption and rejects issue after gate close", async () => {
  grantStore.pauseRedeemBeforeCommit();
  const redeem = grantStore.redeem(token, "passive");
  await grantStore.redeemReachedPause();
  const drain = startupGate.close("service_restart");
  expect(await promiseState(drain.drained)).toBe("pending");
  await expect(grantStore.issue(validGrantInput)).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  grantStore.releaseRedeem();
  await redeem;
  await drain.drained;
});

it("removes uploaded artifact when gate closes before attachment", async () => {
  artifactStore.pauseAfterVerifiedUpload();
  const ingest = ingestBrowserArtifact(activeRun, validHeaders, pngBytes);
  await artifactStore.uploadReachedPause();
  startupGate.close("service_restart");
  artifactStore.releaseUpload();
  await expect(ingest).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  expect(deleteUploadedObject).toHaveBeenCalledTimes(1);
  expect(attachRunArtifact).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-state/proxy-grant-store.test.ts src/lib/browser-runtime/proxy-urls.test.ts src/lib/browser-runtime/artifacts.test.ts src/controllers/internal/browser-runs.test.ts
```

Expected: FAIL because grants/artifact ingestion do not exist.

- [ ] **Step 3: Implement public grants and opaque URLs**

Issue separate `passive`, `interactive`, and `cdp` grants with 5-minute
expiry, one connection, owner/session binding, and hash-only storage. Return:

```ts
{
  liveViewUrl: `${publicBase}/v2/browser/proxy/${passiveToken}/view`,
  interactiveLiveViewUrl:
    `${publicBase}/v2/browser/proxy/${interactiveToken}/view`,
  cdpUrl: `${publicWsBase}/v2/browser/proxy/${cdpToken}/cdp`,
}
```

Inject `BrowserStartupGate` into proxy grant store. Issue, atomic redeem/use
increment, and revoke each run inside one
`withBrowserStateMutationLease("filesystem_and_database", ...)`. Stop-all
revocation uses one bounded lease. Never mutate a grant after bare
`assertOpen()`.

- [ ] **Step 4: Implement artifact ingestion**

Authenticate active non-ZDR run. Require exact `Content-Length`, maximum
16 MiB, and strict `X-Firecrawl-Artifact-Id`, `-Kind`, `-Content-Type`,
`-Byte-Size`, and `-Sha256`; reject duplicate/unknown namespaced headers,
chunking, EOF/trailing bytes, and digest mismatch. Cap 8 objects and 32 MiB
per run. Store under stable owner/request/scrape/session/run prefix, persist
verified bytes before acquiring lease; then use one mutation lease to persist
manifest and append bounded run reference with compare-and-set. If gate closes
before lease acquisition or manifest/attachment fails, delete exact uploaded
object best-effort and leave no manifest/run attachment. Extend old
artifact manifest checksum as nullable; browser artifacts always require it.

Inject same gate into internal artifact controller and artifact service.
Capability check and final manifest/run DB mutations use leases; streaming and
hashing up to 16 MiB occur without a lease. Grant and artifact reads may assert
open, but every issue/redeem/revoke/attach mutation uses lease.

- [ ] **Step 5: Run tests**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-state/proxy-grant-store.test.ts src/lib/browser-runtime/proxy-urls.test.ts src/lib/browser-runtime/artifacts.test.ts src/controllers/internal/browser-runs.test.ts
```

Expected: PASS for expiry, replay, permission, cross-owner, revocation,
grant/reconciliation races, artifact attach/gate race, budgets, checksums, ZDR,
rollback, and redaction.

- [ ] **Step 6: Commit grants and artifacts**

```bash
git add apps/api/src/lib/browser-state/proxy-grant-store.ts apps/api/src/lib/browser-state/proxy-grant-store.test.ts apps/api/src/lib/browser-runtime/proxy-urls.ts apps/api/src/lib/browser-runtime/proxy-urls.test.ts apps/api/src/lib/browser-runtime/artifacts.ts apps/api/src/lib/browser-runtime/artifacts.test.ts apps/api/src/lib/artifacts/manifest.ts apps/api/src/lib/artifacts/local-manifest.ts apps/api/src/controllers/internal/browser-runs.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: secure browser grants and artifacts" -m "Issue owner-bound proxy grants with hash-only storage and ingest
bounded browser artifacts through authenticated run callbacks.

Verify content hashes and preserve existing artifact compatibility."
```

### Task 12: Preserve direct Browser and scrape Interact APIs

**Files:**
- Modify: `apps/api/src/controllers/v2/browser.ts`
- Create: `apps/api/src/controllers/v2/browser.test.ts`
- Modify: `apps/api/src/controllers/v2/scrape-browser.ts`
- Create: `apps/api/src/controllers/v2/scrape-browser.test.ts`
- Modify: `apps/api/src/lib/scrape-interact/browser-agent.ts`

- [ ] **Step 1: Write public controller compatibility tests**

```ts
it("keeps direct defaults and returns only opaque API URLs", async () => {
  const response = await invokeBrowserCreate({});
  expect(orchestrator.createDirectSession).toHaveBeenCalledWith(
    expect.objectContaining({ ttlSeconds: 600, activityTtlSeconds: 300 }),
  );
  expect(response.body.cdpUrl).toContain("/v2/browser/proxy/");
  expect(JSON.stringify(response.body)).not.toContain("browser-service");
});

it("submits one full prompt job and returns action/turn counts", async () => {
  adapter.executePromptRun.mockResolvedValue({
    output: "done", turnCount: 3, actionCount: 2,
    usage: { inputTokens: 100, outputTokens: 20 },
    protocol: {
      toolEventCount: 0, approvalEventCount: 0,
      decisionSchemaVersion: 1, observationSchemaVersion: 1,
    },
  });
  const response = await invokeInteract({ prompt: "Read the heading" });
  expect(adapter.executePromptRun).toHaveBeenCalledTimes(1);
  expect(response.body.output).toBe("done");
});

it("rejects controller mutations after startup gate closes", async () => {
  startupGate.close("service_restart");
  for (const invoke of [
    () => invokeBrowserCreate({}),
    () => invokeBrowserExecute(browserId, { code: "1" }),
    () => invokeBrowserDelete(browserId),
    () => invokeInteract({ prompt: "read" }),
    () => invokeInteractStop(scrapeId),
  ]) {
    expect((await invoke()).status).toBe(503);
  }
  expect(directBrowserStateStoreMutation).not.toHaveBeenCalled();
});
```

Add tests for exact prompt/code XOR, `allowedDomains`, 8-origin cap, ownership,
ZDR/replay 409, session reuse, profile 409, TTL normalization, list URL
rotation, expired 410, unavailable adapters, error mappings, and duplicate
stop.

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run src/controllers/v2/browser.test.ts src/controllers/v2/scrape-browser.test.ts
```

Expected: local cases FAIL because controllers still use private endpoint
fields, replay scripts, or Gemini loop.

- [ ] **Step 3: Refactor direct Browser controllers**

Create/list/execute/delete use orchestrator and durable state. Preserve public
response fields and omitted defaults 600 absolute/300 idle; accept maxima
3600/600 and normalize idle <= absolute. Validate `allowedDomains` as ASCII
hostnames without URL syntax, port, wildcard, credential, localhost, or IP;
union with navigation origins <=8. Execute creates one durable code run.
Unavailable code adapter returns typed 503 without destroying ready browser.
List mints fresh URLs; delete is idempotent.

Inject `BrowserStartupGate` for read admission, but route every mutation only
through Task 9 orchestrator or Task 10 action coordinator. Controllers never
call browser-state store, capability store, grant store, artifact attachment,
or filesystem mutators directly. List/read may use `assertOpen()`; create,
execute, delete, Interact, and stop rely on service-level mutation leases and
map lease rejection to sanitized `browser_state_unavailable` 503.

- [ ] **Step 4: Replace local scrape Interact loop**

Enforce exactly one of prompt/code. Load owned replay state before session
creation; ZDR, unavailable, or unsupported replay returns actionable 409.
Reuse only owned ready session, else checkpoint-create one with 3600/600.

Prompt path creates durable run/capability and calls `executePromptRun` once
with original prompt, initial observation, exact model/effort, schema versions,
loop policy, and <=300-second caller deadline. The adapter performs subsequent
turns by action callback. API does not run a model loop inside controller.
Persist final output, usage, turn/action counts, and terminal state. Reject
count mismatch or nonzero tool/approval events as `model_protocol_error`.
If gate closes during host execution, coordinator interruption owns terminal
recovery; controller does not persist output through an unleased fallback.

Code path keeps existing output/stdout/result/stderr/exit fields through the
same adapter abstraction. Stop cancels current execution, revokes authority
and proxy URLs, closes browser/profile, persists one terminal state, and is
idempotent. Remove local Gemini/cloud fallback; preserve hosted behavior only
when the local feature is disabled.

- [ ] **Step 5: Run public controller tests**

```bash
pnpm --dir apps/api exec vitest run src/controllers/v2/browser.test.ts src/controllers/v2/scrape-browser.test.ts
```

Expected: PASS for direct compatibility, prompt/code response fields, one
outer adapter job, action/turn accounting, replay, domains, profile locking,
typed failures, no local provider fallback, and terminal stop.

- [ ] **Step 6: Commit controller integration**

```bash
git add apps/api/src/controllers/v2/browser.ts apps/api/src/controllers/v2/browser.test.ts apps/api/src/controllers/v2/scrape-browser.ts apps/api/src/controllers/v2/scrape-browser.test.ts apps/api/src/lib/scrape-interact/browser-agent.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: route browser APIs through local runtime" -m "Preserve direct Browser and scrape Interact contracts while routing
sessions and one-job prompt or code runs through local boundaries.

Remove local Gemini and cloud fallback paths and keep stop terminal."
```

### Task 13: Proxy live view and CDP through API

**Files:**
- Create: `apps/api/src/controllers/v2/browser-proxy.ts`
- Create: `apps/api/src/controllers/v2/browser-proxy.test.ts`
- Modify: `apps/api/src/routes/v2.ts`

- [ ] **Step 1: Write proxy permission and revocation tests**

```ts
it("serves a no-store viewer", async () => {
  const response = await request(app)
    .get(`/v2/browser/proxy/${passiveToken}/view`);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["content-security-policy"])
    .toContain("frame-ancestors 'none'");
});

it("passive grant cannot open input or CDP", async () => {
  await expect(openProxy(passiveToken, "interactive"))
    .rejects.toMatchObject({ code: 1008 });
  await expect(openProxy(passiveToken, "cdp"))
    .rejects.toMatchObject({ code: 1008 });
});

it("does not open private stream when gate closes before redeem", async () => {
  startupGate.close("service_restart");
  await expect(openProxy(passiveToken, "passive"))
    .rejects.toMatchObject({ code: 1013 });
  expect(browserClient.createRelayGrant).not.toHaveBeenCalled();
  expect(browserClient.openStream).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test and verify red**

```bash
pnpm --dir apps/api exec vitest run src/controllers/v2/browser-proxy.test.ts
```

Expected: FAIL because proxy routes do not exist.

- [ ] **Step 3: Add fixed viewer and bounded WebSocket relay**

Serve fixed same-origin HTML/JS/CSS with no token/page interpolation and
`default-src 'none'`, same-origin connect/script/style, data images,
`frame-ancestors 'none'`, `no-store`, `no-referrer`, and `nosniff`.

Hash and atomically redeem token, verify permission/session/expiry/use, mint a
one-use private relay grant, and connect with service identity. Proxy
controller injects Task 11 leased grant store; redeem/use mutation and bounded
private relay-grant creation share one mutation lease. If gate closes before
lease acquisition, close WebSocket 1013 and make no Browser Service call. Cap
messages
at 64 KiB; apply backpressure and bidirectional close/cancellation. Require
configured API Origin for view streams; CDP may omit Origin but needs CDP
grant. Never log tokens, private URLs, CDP payloads, or page input.

- [ ] **Step 4: Run proxy tests**

```bash
pnpm --dir apps/api exec vitest run src/controllers/v2/browser-proxy.test.ts
```

Expected: PASS for permission separation, expiry, replay, owner binding,
stop revocation, CSRF/origin, bounds, backpressure, and disconnect cleanup.

- [ ] **Step 5: Commit public proxy**

```bash
git add apps/api/src/controllers/v2/browser-proxy.ts apps/api/src/controllers/v2/browser-proxy.test.ts apps/api/src/routes/v2.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: proxy browser streams through API" -m "Redeem owner-bound grants and relay passive, interactive, and CDP
streams without exposing Browser Service addresses.

Add restrictive viewer headers, origin checks, bounds, and revocation."
```

### Task 14: Wire private Compose and harness lifecycle

**Files:**
- Modify: `compose.local.yaml`
- Modify: `.env.example.local`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/harness.ts`
- Create: `apps/api/src/harness-browser-service.ts`
- Create: `apps/api/src/harness-browser-service.test.ts`

- [ ] **Step 1: Write harness lifecycle tests**

Prove the harness builds `firecrawl-local-browser-service:harness`, starts one
fresh uniquely named owned container per invocation with a generated service
key, service-generated process nonce, generated state namespace, temporary
state bind, disposable API database,
and unique Compose/container project identity. Expose only a harness-owned
allocated loopback port, wait for authenticated liveness, pass exact API
environment before API spawn, wait for API-confirmed matching readiness after
API reconciliation, and remove container/root/database on success, failure,
or signal. Never reuse or attach to a pre-existing Browser Service, API
database, state root, namespace, container, or port.

```ts
it("registers cleanup before liveness wait", async () => {
  liveness.reject(new Error("not live"));
  await expect(startHarnessBrowserService(deps)).rejects.toThrow("not live");
  expect(events).toEqual([
    "build", "create-root", "run", "register-cleanup", "live",
    "remove-container", "remove-root",
  ]);
});

it("rejects every external Browser Service override", async () => {
  for (const name of [
    "TEST_BROWSER_SERVICE_URL",
    "TEST_BROWSER_SERVICE_API_KEY",
    "BROWSER_SERVICE_URL",
    "BROWSER_SERVICE_API_KEY",
    "LOCAL_BROWSER_STATE_ROOT",
    "BROWSER_PROFILE_ROOT",
    "BROWSER_STATE_NAMESPACE",
    "TEST_APPLICATION_DATABASE_URL",
    "APPLICATION_DATABASE_URL",
  ]) {
    await expect(startHarnessBrowserService(depsWithEnv({
      [name]: "external-value",
    }))).rejects.toMatchObject({
      category: "harness_external_browser_override_rejected",
    });
    expect(containerRuntime.run).not.toHaveBeenCalled();
  }
});

it("uses a fresh owned root namespace and API database each run", async () => {
  const first = await startAndStopHarness();
  const second = await startAndStopHarness();
  expect(second.containerName).not.toBe(first.containerName);
  expect(second.stateRoot).not.toBe(first.stateRoot);
  expect(second.stateNamespace).not.toBe(first.stateNamespace);
  expect(second.databaseName).not.toBe(first.databaseName);
  expect(second.processNonce).not.toBe(first.processNonce);
  expect(first.cleaned).toEqual({ container: true, root: true, database: true });
});
```

Add successful order assertion:

```ts
expect(events).toEqual([
  "browser:start",
  "browser:live",
  "api:start",
  "api-process:operational-retention:start",
  "api-process:recovery",
  "api-process:cleanup-intents",
  "api-process:reconcile",
  "browser:ready",
  "api:admit",
  "api-process:browser-retention:start",
]);
expect(harnessParent.interruptUnfinishedBrowserWork).not.toHaveBeenCalled();
expect(harnessParent.recoverCleanupIntents).not.toHaveBeenCalled();
expect(harnessParent.startLocalRetentionService).not.toHaveBeenCalled();
```

Add a blocked-reconciliation case and assert operational/artifact retention
started once but no `api-process:browser-retention:start` event. Restart
Browser Service once and assert one API-process recovery/reconciliation
sequence, not one from harness parent plus one from API. These event assertions
come from test-only API lifecycle notifications; harness never invokes those
functions.

- [ ] **Step 2: Run test and verify red**

```bash
pnpm --dir apps/api exec vitest run src/harness-browser-service.test.ts
```

Expected: FAIL because lifecycle helper does not exist.

- [ ] **Step 3: Add private Compose service**

Build `apps/browser-service`, run on backend network with no published port,
2 CPUs, 4 GiB memory/no swap, 1 GiB noexec/nosuid tmpfs, and shared
`browser-state:/var/lib/firecrawl-browser`. Healthcheck authenticated live
state only; API coordinator establishes ready state. Pass private URL/key and
one operator-supplied canonical `BROWSER_STATE_NAMESPACE` to both API and
Browser Service, plus reconciliation limits to API. Each namespace resolves
below the volume root; neither process accepts a different root from a
request. Keep `LOCAL_BROWSER_SERVICE_ENABLED=false` in both Compose and
`.env.example.local`. Never mount Docker
socket or adapter token in this task.

- [ ] **Step 4: Implement exact harness lifecycle**

Use argument arrays and existing container-runtime detection. Start Browser
Service only for exact `pnpm test:snips:local-browser`; register cleanup before
authenticated live wait. Before any build/run, reject the override variables
listed in Step 1 when inherited from caller environment; the harness creates
and overwrites none of them from external input. Generate cryptographically
random invocation ID, service key, and state namespace. Create an empty
mode-0700 temporary root owned by invocation and a fresh disposable PostgreSQL
database; fail if root is not newly created, resolves outside harness temp
parent, has unexpected entries, or database already exists. Container name,
network/project identity, loopback port, bind source, API database URL, and
namespace all derive from this invocation. Reconciliation is allowed only
against this owned canonical root/namespace; never accept an arbitrary path or
clean an unmanaged root.

Browser Service alone generates its 32-byte process nonce. Harness reads it
from authenticated live health, requires canonical 43-character base64url,
requires it differs from every prior process in that invocation, and passes no
nonce override. API reconciliation must bind that observed nonce.

Return live handle and generated environment to harness, spawn API, then wait
for authenticated ready whose nonce/digest equal coordinator's binding.
Remove existing harness-parent imports/calls that run
`interruptUnfinishedBrowserWork`, cleanup-intent recovery, or
`createLocalRetentionService`; API `index.ts` is sole operational, artifact,
and browser-state retention owner. Never wait ready before API spawn and never
start any retention from harness. On cleanup, signal API and wait while its
coordinator stops monitor and its one retention service, remove Browser
Service, remove owned root, then drop disposable PostgreSQL. Configure API and
service with same generated state root mapping and namespace. Missing Docker
or Podman uses existing missing-runtime error; do not install or start an
unmanaged process.

- [ ] **Step 5: Run harness and Compose checks**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/harness-browser-service.test.ts src/lib/browser-runtime/reconciliation-coordinator.test.ts
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --quiet
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml build browser-service api
```

Expected: lifecycle tests PASS in live/API-reconcile/ready order, Compose
config exits 0, image builds from committed digest, Browser Service has no
`ports`, feature remains false, only API publishes `127.0.0.1:3002`, override
environment is rejected, two invocations share no identity/state/database,
and cleanup removes only owned resources.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add compose.local.yaml .env.example.local apps/api/package.json apps/api/src/harness.ts apps/api/src/harness-browser-service.ts apps/api/src/harness-browser-service.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: add private browser service runtime" -m "Run Browser Service on the private network with bounded resources and
a shared durable state volume.

Manage disposable harness instances through live, API reconcile, ready,
and exact cleanup."
```

### Task 15: Add Browser, Interact, and real-Codex smoke contracts

**Files:**
- Modify: `apps/api/src/__tests__/snips/v2/lib.ts`
- Create: `apps/api/src/__tests__/snips/v2/browser-local.test.ts`
- Modify: `apps/api/src/__tests__/snips/v2/scrape-browser.test.ts`
- Create: `apps/api/src/__tests__/snips/v2/browser-real-codex.test.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Add public Browser and Interact helpers**

Add create/list/execute/delete helpers with caller identity. Expand Interact
body to exact prompt/code XOR plus language, timeout, origin, integration,
existing session, and `allowedDomains`.

```ts
export const browserCreateRaw = (body: BrowserCreateInput, identity: Identity) =>
  request(TEST_API_URL).post("/v2/browser")
    .set("Authorization", `Bearer ${identity.apiKey}`).send(body);

export const browserExecuteRaw = (
  id: string, body: BrowserExecuteInput, identity: Identity,
) => request(TEST_API_URL).post(`/v2/browser/${encodeURIComponent(id)}/execute`)
  .set("Authorization", `Bearer ${identity.apiKey}`).send(body);
```

- [ ] **Step 2: Write deterministic service/API snips**

Gate on self-hosted local-browser mode. Cover direct create/list/delete,
profiles, replay restore, allowed origins, 8-origin limit, passive/interactive/
CDP separation, cross-owner denial, unavailable host adapters, duplicate stop,
and restart followed by a new replayed request. Use fixture pages; do not use a
public site as proof.

```ts
it("creates, lists, and deletes a local browser", async () => {
  const created = await browserCreateRaw({
    ttl: 60, activityTtl: 30, streamWebView: true,
  }, identity);
  expect(created.statusCode).toBe(200);
  expect(created.body.cdpUrl).toContain("/v2/browser/proxy/");
  expect((await browserListRaw(identity)).body.sessions)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.id }),
    ]));
  expect((await browserDeleteRaw(created.body.id, identity)).body.success)
    .toBe(true);
});
```

```bash
pnpm --dir apps/api harness pnpm test:snips:local-browser
```

Expected before host plan: deterministic Browser lifecycle and restart
reconciliation cases PASS; prompt
and code cases return typed `codex_unavailable`/`sandbox_unavailable` 503.

- [ ] **Step 3: Add post-host real Codex smoke**

Skip unless `RUN_REAL_CODEX_BROWSER_SMOKE=1`. Use a controlled fixture whose
prompt requires at least one side-effecting typed action and exact final text.
After success, query the test database by returned run/session IDs and assert:

```ts
expect(run.model).toBe("gpt-5.6-terra");
expect(run.reasoningEffort).toBe("medium");
expect(run.toolEventCount).toBe(0);
expect(run.approvalEventCount).toBe(0);
expect(run.actionCount).toBe(actions.length);
expect(run.turnCount).toBe(actions.length + 1);
expect(actions.map(action => action.sequence)).toEqual(
  actions.map((_, index) => index + 1),
);
expect(actions.every(action => action.state === "succeeded")).toBe(true);
expect(new Set(actions.map(action => action.actionId)).size)
  .toBe(actions.length);
expect(browserServiceEffectCount).toBe(actions.length);
```

Replay one recorded matching callback through the authenticated test adapter
fixture and assert same observation plus unchanged effect count. Replay with
same sequence and another hash and expect `model_protocol_error` 502. Assert
no MCP/tool/approval events in persisted adapter protocol metadata. Stop twice
and assert no live capability, proxy grant, writer lease, adapter process, or
browser runtime.

The host-execution plan must run:

```bash
RUN_REAL_CODEX_BROWSER_SMOKE=1 pnpm --dir apps/api harness pnpm vitest run src/__tests__/snips/v2/browser-real-codex.test.ts
```

Expected after host adapter installation: PASS with one active installed Codex
process under rolling capability gate,
durable contiguous action ledger, no duplicate effects, zero tool/approval
events, exact final output, and complete cleanup.

- [ ] **Step 4: Run deterministic regression**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
corepack pnpm --dir apps/browser-service install --frozen-lockfile
corepack pnpm --dir apps/browser-service test
corepack pnpm --dir apps/browser-service build
pnpm --dir apps/api exec vitest run --no-file-parallelism src/lib/browser-runtime src/lib/browser-state src/lib/scrape-interact src/controllers/internal/browser-runs.test.ts src/controllers/v2/browser.test.ts src/controllers/v2/browser-proxy.test.ts src/controllers/v2/scrape-browser.test.ts
pnpm --dir apps/api build
```

Expected: all deterministic tests and builds PASS. Real Codex smoke reports
SKIP unless explicitly enabled; a skip never counts as host acceptance.

- [ ] **Step 5: Commit acceptance coverage**

```bash
git add apps/api/src/__tests__/snips/v2/lib.ts apps/api/src/__tests__/snips/v2/browser-local.test.ts apps/api/src/__tests__/snips/v2/scrape-browser.test.ts apps/api/src/__tests__/snips/v2/browser-real-codex.test.ts apps/api/package.json
apps/api/.husky/_/pre-commit
git commit -m "test: cover local browser runtime" -m "Exercise direct Browser, replayed Interact, profiles, origins, grants,
action coordination, stop, and restart against controlled fixtures.

Define the real Codex smoke for durable actions, callback deduplication,
and zero model-tool events."
```

## Final verification for this plan

- [ ] Prepend installed Node `22.22.1`; assert `node --version` is
  `v22.22.1` and `corepack pnpm --version` is `10.33.0`.
- [ ] Run Browser Service frozen install, test, and build through Corepack;
  expect all PASS and no lockfile change. `pnpm list --depth 0` must report the
  11 exact direct versions from Task 1, including Vitest `4.1.9`; no direct
  dependency may contain a range or tag.
- [ ] Run Browser Service TypeScript tests only through `vitest run`; inspect
  Tasks 1-6 files for explicit
  `import { describe, expect, test, vi } from "vitest"`. Run only the two `.mjs`
  bootstrap tests through `node --test`.
- [ ] Run both independent private-contract inventory tests; expect Browser
  Service and API normalized contracts/fingerprints equal the one canonical
  V1 fixture and reject a one-field drift mutation.
- [ ] Run `pnpm --dir apps/api build`; expect PASS.
- [ ] Run Task 15 focused API tests; expect all PASS.
- [ ] Run Task 8 database integration tests with `--no-file-parallelism`;
  expect snapshot/recovery/restart/retention ordering PASS.
- [ ] Run `pnpm --dir apps/api harness pnpm test:snips:local-browser`; expect
  lifecycle cases PASS and host execution unavailable until its plan lands.
- [ ] Run
  `docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --quiet`;
  expect exit 0.
- [ ] Resolve Playwright raw manifest again; expect digest equals committed
  Dockerfile digest. Build Browser Service twice with `--pull --no-cache`;
  expect Node `v22.22.1`, Playwright `1.61.1`, and `pwuser` both times.
- [ ] In both digest-pinned `browser-test` images, run real bundled-Chromium
  egress tests. Require positive controls plus zero private HTTP/WS hits, proxy
  observation/rejection for top-level and subresources across localhost,
  127/8, link-local IPv4/IPv6, and DNS-private targets, and zero hardened
  QUIC/WebRTC UDP packets. Missing proof is failure, never skip.
- [ ] In both `browser-test` images, run replay restore tests. Require cookies,
  localStorage, and IndexedDB equality immediately after `setStorageState`, no
  pre-restore network, exact canonical byte/checksum equality, and zero profile
  publication on mismatch/timeout/crash.
- [ ] Run
  `docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml build browser-service api`;
  expect exit 0.
- [ ] Inspect Compose; expect only API published on `127.0.0.1:3002`.
- [ ] With flag false, expect typed local unavailable behavior and no fallback.
- [ ] With browser flag false and local persistence enabled, advance one
  retention interval; expect operational and artifact phases once, browser
  phase zero, and no coordinator. With flag true, expect one API owner and no
  harness/service retention owner.
- [ ] With flag true and dependencies healthy, expect Browser lifecycle snips
  PASS; prompt/code remain typed unavailable until host adapter exists.
- [ ] Restart Browser Service; expect nonce change closes API gate, old work is
  interrupted, one reconciliation occurs, and gate reopens only after matching
  ready nonce/digest.
- [ ] Search local paths for Gemini, Fireworks, and Firecrawl Cloud fallback;
  expect none.
- [ ] Inspect action tests: every accepted proposal persists `prepared` before
  dispatch; matching known callback replays do not dispatch; hash mismatch
  fails; each strict result/response cap is enforced; unsupported/cyclic/
  non-finite/oversized post-dispatch output becomes uncached
  `outcome_unknown` and terminates run/session; no action auto-retries.
- [ ] Run harness twice with hostile inherited override variables. Expect
  override rejection before container launch, then two clean runs with unique
  container/project, nonce, namespace, root, port, key, and disposable API
  database; cleanup removes only owned resources.
- [ ] After host plan, run real Codex smoke three times; expect three PASS runs,
  contiguous ledgers, exact effect counts, zero tools/approvals, and cleanup.
- [ ] Run `git status --short`; expect clean after each commit.
- [ ] Run actual repository hook before every commit; expect exit 0.

## Self-review checklist

- Spec coverage: dedicated persistent Browser Service, complete typed operation
  set, strict profiles, replay checkpoints, origin/SSRF enforcement, direct
  Browser compatibility, prompt/code Interact, terminal stop, live view/CDP,
  artifacts, and private networking all map to tasks.
- Host loop boundary: one API `executePromptRun` call carries locked model,
  effort, schema versions, loop budgets, initial observation, and deadline;
  result carries final output plus turn/action counts and zero-event protocol
  evidence.
- Action safety: API recomputes identity metadata, persists before dispatch,
  authorizes server-held policy, permits one in-flight action, never retries,
  caches known replay, rejects side-effect duplicates, permits repeated reads,
  and terminates ambiguous outcomes.
- Type consistency: `SubmitBrowserActionV1.proposalHash` is recomputed by API
  and passed as `BrowserActionExecutionV1.normalizedProposalHash`; both retain
  the same adapter job, action ID, sequence, effect, and `BrowserOperation`.
  Public IDs, private runtime IDs, API proxy grants, and Browser Service relay
  grants remain distinct.
- Limits and errors: 10,000 prompt characters, 40,000 snapshot characters,
  64 KiB observation, 1 MiB aggregate observations, 256 KiB final output,
  25 actions, 26 turns, 300 seconds, and approved HTTP mappings appear in
  implementation and tests.
- Security: model receives no MCP, tools, browser transport, capability,
  endpoint, credential, shell, workspace, Docker, or arbitrary network;
  Browser Service remains private, manually proxies Chromium with
  `bypass:"<-loopback>"`, disables QUIC/non-proxied WebRTC UDP, and validates
  every egress destination.
- Rollout: real Codex smoke is defined here but cannot pass by skip; host plan
  must run it against active installed Codex under rolling capability gate
  before feature enablement.
- Startup authority: Browser Service is live before API, but no Browser route
  admits work until API recovery, one repeatable-read snapshot, reconciliation,
  and matching ready health succeed for current process nonce. Retention starts
  afterward and restart repeats same sequence.
- Mutation drain: gate close rejects admission synchronously, then coordinator
  awaits all unified filesystem/database mutation leases before recovery. Dead
  cleanup-intent writers converge under exact process identity and CAS before
  snapshot; live/unknown writers remain authoritative.
- Mutation coverage: session/profile/run transitions, actions, capabilities,
  grants, artifact attachment, stop, and controller-facing writes all use
  short gate leases. Host execution and artifact streaming hold none; callback
  and gate-close races either drain known completion or recover conservatively.
- Ownership and retries: API process alone owns operational, artifact, and
  browser-state retention plus recovery; harness owns only fresh disposable
  process/container/root/database lifecycle. Each cycle has 4 attempts,
  250/500/1,000 ms backoff, 60-second budget, and 30-second runtime cooldown.
- Toolchain: every Browser Service install/test/build/start uses installed Node
  `22.22.1`, Corepack pnpm `10.33.0`, frozen lock, Playwright package/image
  `1.61.1`, exact direct dependencies, Vitest `4.1.9`, and committed Noble
  digest; two no-cache builds verify identities and real bundled Chromium.
- Replay restore: existing generation plus checkpoint is rejected. Otherwise
  `setStorageState` runs on an isolated egress-confined persistent context
  immediately before export/network work; canonical accepted bytes/checksum
  must match or all runtime/profile work is discarded without publication.
- Contract drift: one canonical V1 inventory locks every route, field, type,
  bound, status, header, and response cap; Browser Service and API consume and
  fingerprint it independently.
- Reconciliation safety: complete authority validates before deletion; only
  recognized old orphans enter same-root quarantine; exact retry is idempotent;
  wrong/conflicting nonce or corrupt/missing/unsafe state performs no deletion.
