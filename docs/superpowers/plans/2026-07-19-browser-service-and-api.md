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
only fresh disposable runtime/database resources. Adapter job, supervisor,
process, and capability identity is durably bound before host work or the
first callback.

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
Before its Task 1 runs, also replace stale opaque `processId` acceptance with
this plan's exact canonical job/supervisor UUID plus positive process ID
handshake and awaited `onAccepted` authorization barrier. Host callbacks must
send the three locked headers; no host task may infer first-callback authority
from an action row.

After revising that host plan, require this stale-contract scan to exit zero:

```bash
! rg -n '0\.144\.5|observer\.onAccepted\(processId\)|processId: string' docs/superpowers/plans/2026-07-19-browser-host-execution-and-operations.md
```

All Browser Service host commands deliberately prepend the already installed
Node `22.22.1` directory:

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node --version
```

Expected: `v22.22.1`. Do not invoke Corepack or pnpm until Task 1 has created
`apps/browser-service/package.json`; only then run Corepack from that package
with process cwd exactly `apps/browser-service` so it reads the committed
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
- `apps/browser-service/src/startup-state.ts` — stable process identity,
  control-generation handoff/drain, readiness latch, generation-scoped digest
  replay rules, and browser-work admission.
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

- `apps/api/src/db/migrations/0007_browser_control_generation.sql` — singleton
  cross-process browser mutation fence and monotonic database epoch.
- `apps/api/src/db/migrations/0008_browser_adapter_bindings.sql` — durable
  run/capability job, supervisor, process, and activation constraints.
- `apps/api/src/db/schema/public.ts` and
  `apps/api/src/db/migrate.integration.test.ts` — Drizzle parity and migration
  constraint coverage for adapter bindings.
- `apps/api/src/config.ts` — local feature and private service configuration.
- `apps/api/src/lib/local-runtime-config.ts` — fail-closed local validation.
- `apps/api/src/lib/scrape-interact/browser-service-client.ts` — typed,
  deadline-aware Browser Service client.
- `apps/api/src/lib/scrape-interact/browser-service-contracts.ts` — API-owned
  closed V1 schemas and canonical-inventory fingerprint.
- `apps/api/src/lib/browser-state/filesystem-store.ts` — sole canonical
  storage-state file owner under direct `replay/<owner>/<scrape>/...` paths.
- `apps/api/src/lib/scrape-interact/replay-store.ts` — checkpoint metadata,
  cleanup intents, and file-backed replay-request reconstruction.
- `apps/api/src/lib/browser-runtime/startup-gate.ts` — fail-closed browser work
  and browser-state mutator/retention gate.
- `apps/api/src/lib/browser-runtime/reconciliation-snapshot.ts` —
  repeatable-read PostgreSQL authority snapshot and canonical digest.
- `apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts` — service
  discovery, control-generation takeover, recovery, reconciliation, fenced
  ready verification, and restart coalescing.
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
- `apps/api/src/lib/browser-state/capability-store.ts` — pending/activated
  adapter binding plus server-held operation, origin, byte, action, and
  deadline authority.
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
- `apps/api/src/cli/browser-stale-contract-scan.ts` — checked production-file
  discovery/import closure plus AST/text invariants for stale contracts.
- `apps/api/src/cli/browser-stale-contract-scan.test.ts` — one positive
  mutation fixture per stale-contract rule and real-tree coverage.
- `apps/api/src/harness-browser-service.ts` — disposable service lifecycle.
- `apps/api/src/harness-browser-service.test.ts` — harness cleanup coverage.
- `apps/api/src/harness.ts` and `apps/api/package.json` — managed snip command.

### Local runtime

- `compose.local.yaml` — private service and shared browser-state volume.
- `.env.example.local` — non-secret disabled rollout configuration.
- `scripts/local-firecrawl` — Browser-first, API-owned migration lifecycle.
- `scripts/local-firecrawl.test.mjs` — fake-Compose startup-order coverage.

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

Initial `GET /health/live` discovery and
`POST /v1/control-generations` are the only bootstrap requests that omit
generation fencing headers. Every request after a successful handoff,
including scoped live/ready health, reconciliation, session, action, grant,
artifact, stream, profile, and close requests, also carries exact
`x-firecrawl-process-nonce` and
`x-firecrawl-control-generation-nonce` headers. Both are canonical `Token`
values and must match current service state before request parsing, mutation,
writer acquisition, or stream upgrade. The control-generation nonce is never
returned by discovery health.

The single source of contract truth is the checked-in, canonical JSON fixture
`apps/browser-service/contracts/private-v1.contract.json`. It has exactly the
top-level members `version:1`, `routes`, and `definitions`; fingerprint input
uses recursively sorted object keys and no insignificant whitespace,
and the following route inventory. Each route record locks method, path,
request definition or `null`, success status, response definition, request
byte cap, response byte cap, and streaming metadata. No endpoint may be added
to either implementation without changing this fixture.

```text
POST   /v1/control-generations                          CreateControlGenerationV1 -> 201 ControlGenerationV1
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
GET    /health/live                                      null -> 200 LiveDiscoveryV1 | ScopedLiveHealthV1
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

type CreateControlGenerationV1 = {
  version: 1;
  processNonce: Token;
  apiInstanceId: Id;
  idempotencyKey: Token;
};
type ControlGenerationV1 = {
  version: 1;
  processNonce: Token;
  controlGenerationNonce: Token;
  apiInstanceId: Id;
};

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
}; // canonical encoded StorageStateV1 <= 2 MiB

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
  checksum: Sha256;                // canonical StorageStateV1 file bytes
  byteSize: number;                // those bytes; integer 1..2_097_152
  storageState: StorageStateV1;
  finalUrl: HttpUrl;
  fingerprint: {
    finalUrl: HttpUrl;             // must equal finalUrl
    titleSha256: Sha256;
    bodyTextSha256: Sha256;
  };
};
// statePath file is only canonical StorageStateV1 bytes, never this envelope.

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

Health, control handoff, and reconciliation are private too. Initial
`GET /health/live` discovery returns strict
`{ version: 1, status, processNonce }` and never reveals or authorizes a
control generation. After handoff, scoped live health requires both fencing
headers and returns strict
`{ version: 1, status, processNonce, controlGenerationNonce }`.
Generation-scoped ready returns 503 with strict
`{ version: 1, status: "unready", processNonce,
controlGenerationNonce, category }`; after reconciliation it returns strict
`{ version: 1, status: "ready", processNonce, controlGenerationNonce,
snapshotDigest }`. Ordered shutdown closes listener before draining work, so
no new live or ready health response is served. Already accepted requests fail
admission through `requireReady(binding)` once shutdown starts.

`processNonce` is one unpadded base64url encoding of 32 cryptographically
random bytes, remains stable for the entire Browser Service process lifetime,
and changes only on service process restart. `controlGenerationNonce` is an
independent 32-byte cryptographically random base64url value minted after one
successful API takeover drain. Neither is persisted or logged.

`POST /v1/control-generations` accepts and returns these exact closed types:

```ts
export type CreateControlGenerationV1 = {
  version: 1;
  processNonce: Token;
  apiInstanceId: Id;
  idempotencyKey: Token;
};

export type ControlGenerationV1 = {
  version: 1;
  processNonce: Token;
  controlGenerationNonce: Token;
  apiInstanceId: Id;
};
```

Browser Service serializes handoffs under one process-local mutex and permits
only one physical runtime drain/close operation at a time. The mutex protects
one service-owned handoff wave containing the current tuple owner, that
owner's request transport liveness and absolute deadline, one shared drain
promise, phase `pre_mint | minted | failed`, and bounded tuple tombstones. The first
accepted tuple closes admission synchronously, aborts reconciliation, clears
readiness/cache, records itself as owner, and starts the shared drain exactly
once. Publish the complete wave and shared deferred under the mutex before
invoking the drain callback; synchronous reentry/shutdown sees that wave and
cannot duplicate or overwrite it. That promise boundedly closes/revokes every runtime session, Chromium
context, passive/interactive/CDP stream, relay grant, writer lease, timer, and
uncommitted profile working copy independently of any one HTTP handler.

Before mint, each handler checks mutex-protected tuple ownership after every
await and immediately before mint. If the owner transport aborts/closes or its
deadline expires, mark it orphaned. A fresh authenticated tuple with a new
canonical API instance ID and idempotency key may atomically supersede only
that orphaned current owner, adopt and
await the exact same drain promise, and tombstone the old tuple as
`control_generation_superseded`; it never closes or drains again. The old
handler and every exact old-tuple retry return that category and can never
mint, become owner again, or resurrect readiness. Multiple sequential owner
crashes repeat this transfer one owner at a time. A different tuple cannot
steal a live owner and receives `control_generation_in_progress`. When the
shared drain completes, only the current live, unexpired owner may atomically
change phase to `minted`, cache its response, and publish the new generation.
If the physical drain promise rejects before mint, mutex owner atomically
changes phase to `failed`, clears active-wave ownership, and stores one
immutable terminal failure containing exact category
`control_generation_drain_failed` plus one internal allowlisted detail code
`close_failed | close_deadline_exceeded | drain_invariant_failed`. It mints no
generation and leaves admission closed/unready. Its private transport uses the
standard closed `version/category/message` error envelope; raw causes and the
internal detail code never enter it. Exact tuple replay returns the
byte-identical cached failure; a superseded tuple remains superseded even if
later owner drain fails.

An exact concurrent request while its tuple owner remains live may await the
shared result but never becomes a second owner. If that owner is orphaned but
not yet superseded, exact retry returns `control_generation_in_progress` with
no state change; it cannot revive its transport ownership. After a fresh tuple
supersedes it, every exact replay returns
`control_generation_superseded`.

After phase `minted`, ownership cannot be superseded. Caller timeout,
disconnect, or lost response after mint is recovered by exact cached replay.
A different tuple then starts the next normal handoff with a new full drain.
Exact completed `(processNonce,apiInstanceId,idempotencyKey)` replay returns
its one historical result without draining or minting again. Reusing either
API identity or idempotency key with a different partner is
`control_generation_conflict`. A running API that receives stale-generation
rejection closes its gate permanently and never attempts a takeover loop.

After a failed wave settles, a fresh tuple with new API identity/key may start
a brand-new physical drain. It must re-enumerate the full runtime inventory and
run every idempotent close/revoke/discard step from the cleanup baseline;
already closed/absent resources count as converged, but no partial success,
cursor, rejected promise, or prior admission object is reused. Only this full
redrain may mint.

Retain accepted pending, superseded, failed, and completed handoff tuples plus
terminal failures/results as process-local tombstones for the entire service process
lifetime; never evict and reinterpret an old tuple as a new takeover. Cap
distinct accepted tuples at 1,024. Reserving a first owner or replacement
owner consumes one slot before any state change. At capacity, exact known
completed replay still works, exact superseded replay returns
`control_generation_superseded`, exact failed replay returns its cached drain
failure, and every unknown tuple fails
`control_generation_history_exhausted` without ownership change, close, drain,
or mint. Lookup known exact replay first. For an unknown tuple, tentatively
reserve capacity before evaluating identity/key collision; at capacity history
exhaustion wins, while below-cap collision releases the reservation. An
orphaned owner therefore remains orphaned at capacity until
service restart supplies a fresh process namespace. Replaying completed A
after completed takeover B returns A's historical response while B remains
current, so any A-scoped request still fails
`control_generation_mismatch`.

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
  controlGenerationNonce: Token;
  snapshotDigest: Sha256;
  references: ReconciliationReferenceV1[];
};

export type ReconciliationResultV1 = {
  version: 1;
  processNonce: Token;
  controlGenerationNonce: Token;
  snapshotDigest: Sha256;
  retained: number;
  removed: number;
  missing: 0;
  corrupt: 0;
  ready: true;
};
```

API sorts references by `kind`, `id`, and `path`, serializes fixed-key,
whitespace-free `{version,references}` JSON, excluding process nonce, control
generation nonce, and snapshot digest, and hashes its UTF-8 bytes.
Browser Service independently repeats canonicalization. Each list is capped
at 25,000 entries and request JSON at 16 MiB. Same process/generation/digest
retry returns cached success; another digest for that process/generation fails
`reconciliation_conflicting_replay`. A newly completed control handoff permits
one fresh snapshot digest under the unchanged process nonce because the old
runtime and cache were fully drained. Before filesystem access, excess
references/body returns `reconciliation_snapshot_too_large`; malformed schema,
path, checksum, alias, or digest returns `reconciliation_snapshot_invalid`;
valid stale process returns `reconciliation_nonce_mismatch`; valid current-
process stale generation returns `control_generation_mismatch`.

`retained` and `removed` are integers 0..25,000. The request holds at most
25,000 references and 16 MiB; its response is at most 4 KiB. Health responses
are at most 4 KiB. Health `category` is exactly
`reconciliation_required | reconciliation_in_progress`; all process/control
nonces and digests use `Token`/`Sha256` above. Calling ready without a valid
current generation returns the standard typed error envelope rather than an
unscoped health body.
Control handoff returns 201; exact idempotent replay returns the same 201 body.
`control_generation_in_progress`, `control_generation_conflict`,
`control_generation_superseded`, and `control_generation_mismatch` return 409.
`reconciliation_snapshot_invalid` returns 400;
`reconciliation_snapshot_too_large` returns 413;
`reconciliation_nonce_mismatch` and stale-generation
`control_generation_mismatch` return 409.
Missing generation before handoff is
`control_generation_required` 503. Process mismatch during bootstrap or
reconciliation is `reconciliation_nonce_mismatch` 409. API sanitizes all of
these to public `browser_state_unavailable` without exposing either nonce.
`control_generation_history_exhausted` is a private/public-sanitized 503.
`control_generation_drain_failed` is a private/public-sanitized 503. Its
allowlisted internal detail is logged only as a bounded code, never serialized
in the strict private error envelope, forwarded publicly, or expanded from raw
errors.

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

Both independent implementations name and use these local primitives for
every matching field; no schema may use bare `.uuid()`, `z.uuid()`, `.url()`,
or `z.url()` directly:

```ts
const canonicalUuidSchema = z.string().uuid().refine(
  value => value === value.toLowerCase(),
  "UUID must be canonical lowercase",
);
const httpUrlSchema = z.string().max(8_192).superRefine((value, context) => {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { context.addIssue({ code: "custom", message: "invalid URL" }); return; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" || parsed.password !== "") {
    context.addIssue({ code: "custom", message: "HTTP(S) URL required" });
  }
});
```

Use `canonicalUuidSchema` for every request/response/action/run/session/
profile/grant/artifact/checkpoint UUID, including adapter job/supervisor IDs.
Use `httpUrlSchema` for page URL, final URL, initial URL, origin URL, and
`navigate.url`; additional origin/egress refinements compose on this base.
Contract parity tests reject uppercase UUIDs and `file:`, `mailto:`, `ftp:`,
credential-bearing, relative, and over-8,192-character URLs on both sides.

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
- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API):
  `createSourceFile()` parses JavaScript/TypeScript into an AST that can be
  traversed with `forEachChild()` without emitting or executing source.
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
    "typescript": "5.9.3",
    "ws": "8.21.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "22.20.1",
    "@types/ws": "8.18.1",
    "tsx": "4.23.1",
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
and child-process `cwd` set to the copied fixture root, then asserts nonzero
exit before deleting its temporary root.

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
`1.61.1`, TypeScript `5.9.3`, `ws` `8.21.1`, Zod `4.4.3`,
`@types/express` `5.0.6`,
`@types/node` `22.20.1`, `@types/ws` `8.18.1`, `tsx` `4.23.1`, and Vitest
`4.1.9` as direct dependencies. `typescript` must appear
only in production `dependencies`; the other five type/test packages remain
development-only. Playwright reports its
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

test("control handoff and scoped health reject unknown identity fields", () => {
  expect(createControlGenerationV1Schema.safeParse({
    version: 1,
    processNonce: VALID_NONCE,
    apiInstanceId: VALID_ID,
    idempotencyKey: VALID_TOKEN,
    controlGenerationNonce: VALID_NONCE,
  }).success).toBe(false);
  expect(scopedLiveHealthV1Schema.safeParse({
    version: 1,
    status: "ready",
    processNonce: VALID_NONCE,
  }).success).toBe(false);
});

test("reconciliation rejects malformed filesystem authority", () => {
  expect(reconciliationRequestV1Schema.safeParse({
    version: 1,
    processNonce: "A".repeat(43),
    controlGenerationNonce: VALID_NONCE,
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
  expect(liveDiscoveryV1Schema.parse({
    version: 1,
    status: "live_unreconciled",
    processNonce: VALID_NONCE,
  }).status).toBe("live_unreconciled");
  expect(scopedLiveHealthV1Schema.parse({
    version: 1,
    status: "reconciling",
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
  }).status).toBe("reconciling");
  expect(scopedLiveHealthV1Schema.safeParse({
    version: 1,
    status: "draining",
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
  }).success).toBe(false);
  expect(readyHealthV1Schema.safeParse({
    version: 1,
    status: "ready",
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
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

test("shared primitives reject noncanonical IDs and non-HTTP URLs", () => {
  expect(canonicalUuidSchema.safeParse(VALID_ID.toUpperCase()).success)
    .toBe(false);
  for (const url of ["file:///etc/passwd", "mailto:a@example.test",
    "ftp://example.test/a", "https://user:pass@example.test/"]) {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  }
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
const canonicalUuidSchema = z.string().uuid().refine(
  value => value === value.toLowerCase(),
);
const httpUrlSchema = z.string().max(8_192).superRefine((value, context) => {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { context.addIssue({ code: "custom", message: "invalid URL" }); return; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" || parsed.password !== "") {
    context.addIssue({ code: "custom", message: "HTTP(S) URL required" });
  }
});
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
  z.strictObject({ kind: z.literal("navigate"), url: httpUrlSchema }),
  z.strictObject({
    kind: z.literal("evaluate"), expression: textSchema,
    args: z.record(z.string(), jsonValueSchema),
  }),
]);

export const actionExecutionRequestSchema = z.strictObject({
  version: z.literal(1),
  actionId: canonicalUuidSchema,
  runId: canonicalUuidSchema,
  sequence: z.number().int().min(1).max(25),
  normalizedProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  effect: z.enum(["read_only", "side_effecting"]),
  expectedSessionVersion: z.number().int().nonnegative(),
  operation: browserOperationSchema,
});

export const boundedPageStateSchema = z.strictObject({
  url: httpUrlSchema,
  title: z.string().max(4_096),
  snapshotExcerpt: z.string().max(40_000),
});

const processNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(
  value => Buffer.from(value, "base64url").length === 32 &&
    Buffer.from(value, "base64url").toString("base64url") === value,
);
const controlGenerationNonceSchema = processNonceSchema;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
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

export const createControlGenerationV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: processNonceSchema,
  apiInstanceId: canonicalUuidSchema,
  idempotencyKey: controlGenerationNonceSchema,
});
export const controlGenerationV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: processNonceSchema,
  controlGenerationNonce: controlGenerationNonceSchema,
  apiInstanceId: canonicalUuidSchema,
});

export const reconciliationRequestV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: processNonceSchema,
  controlGenerationNonce: controlGenerationNonceSchema,
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
  controlGenerationNonce: controlGenerationNonceSchema,
  snapshotDigest: sha256Schema,
  retained: z.number().int().nonnegative().max(25_000),
  removed: z.number().int().nonnegative().max(25_000),
  missing: z.literal(0),
  corrupt: z.literal(0),
  ready: z.literal(true),
});

export const liveDiscoveryV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["live_unreconciled", "reconciling", "ready"]),
  processNonce: processNonceSchema,
});
export const scopedLiveHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["live_unreconciled", "reconciling", "ready"]),
  processNonce: processNonceSchema,
  controlGenerationNonce: controlGenerationNonceSchema,
});
export const unreadyHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("unready"),
  processNonce: processNonceSchema,
  controlGenerationNonce: controlGenerationNonceSchema,
  category: z.enum([
    "reconciliation_required",
    "reconciliation_in_progress",
  ]),
});
export const readyHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("ready"),
  processNonce: processNonceSchema,
  controlGenerationNonce: controlGenerationNonceSchema,
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
validates `PORT`, `BROWSER_SERVICE_API_KEY`, `LOCAL_BROWSER_STATE_ROOT`,
`MAX_BROWSER_SESSIONS`, and every bound used
below. `LOCAL_BROWSER_STATE_ROOT` itself is the canonical deployment-isolated
root shared with API. Resolve `replay/`, `profiles/`, and `quarantine/`
directly beneath it; reconciliation and cleanup never accept a
request-supplied root or insert another intermediate root layer.

Add process/control nonce schemas, canonical lowercase UUID/path/SHA-256
reference schemas, strict control-generation request/result,
`reconciliationRequestV1Schema`, `reconciliationResultV1Schema`, and strict
discovery/scoped-live/unready/ready health schemas. Enforce 25,000 references, 16 MiB
encoded request size, unique `(kind,id)`, and same-checksum path aliases with
`superRefine`. Add every reconciliation category from the approved addendum to
`errors.ts`, plus `control_generation_required`,
`control_generation_in_progress`, `control_generation_conflict`, and
`control_generation_superseded`, `control_generation_mismatch`, and
`control_generation_drain_failed`, and
`control_generation_history_exhausted`. Task 1 does not mount routes, inspect
files, start Chromium, or connect PostgreSQL.

- [ ] **Step 8: Run tests and build through the frozen install**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
node --test apps/browser-service/src/runtime-preflight.test.mjs apps/browser-service/src/lockfile.test.mjs
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/contracts.test.ts src/auth.test.ts
corepack pnpm build
```

Expected: tests PASS; build emits `apps/browser-service/dist`.

- [ ] **Step 9: Commit scaffold**

```bash
git add apps/browser-service/contracts/private-v1.contract.json apps/browser-service/package.json apps/browser-service/pnpm-lock.yaml apps/browser-service/tsconfig.json apps/browser-service/src/runtime-preflight.mjs apps/browser-service/src/runtime-preflight.test.mjs apps/browser-service/src/lockfile.test.mjs apps/browser-service/src/contracts.ts apps/browser-service/src/contract-inventory.ts apps/browser-service/src/contracts.test.ts apps/browser-service/src/config.ts apps/browser-service/src/errors.ts apps/browser-service/src/auth.ts apps/browser-service/src/auth.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: define browser service contracts" -m "Add strict private schemas for sessions, typed browser actions,
profiles, control handoff, streams, and health requests.

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
cd apps/browser-service
corepack pnpm exec vitest run src/network-policy.test.ts src/egress-proxy.test.ts src/chromium-egress.integration.test.ts
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
cd apps/browser-service
corepack pnpm exec vitest run src/network-policy.test.ts src/egress-proxy.test.ts src/chromium-egress.integration.test.ts
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

test("starts discoverable but rejects work before generation handoff", () => {
  const state = createStartupState({
    randomBytes: () => Buffer.alloc(32, 7),
  });
  expect(state.liveHealth()).toEqual({
    version: 1,
    status: "live_unreconciled",
    processNonce: Buffer.alloc(32, 7).toString("base64url"),
  });
  expect(() => state.requireReady(unmintedBinding)).toThrow(expect.objectContaining({
    category: "control_generation_required",
  }));
});

test("caches only an exact successful process, generation, and digest", async () => {
  const state = await createHandedOffStartupState();
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

test("handoff drains old runtime before minting a new generation", async () => {
  const state = await createReadyStartupStateWithRuntime();
  const oldProcessNonce = state.processNonce;
  pauseRuntimeDrain();
  const handoff = state.createControlGeneration(
    newApiRequest, liveRequestContext, drainRuntime,
  );
  await runtimeDrainStarted();
  expect(state.liveHealth()).toMatchObject({
    status: "live_unreconciled",
    processNonce: oldProcessNonce,
  });
  expect(state.currentControlGeneration()).toBeNull();
  expect(state.reconciliationCacheSize()).toBe(0);
  expect(state.reconciliationSignal.aborted).toBe(true);
  releaseRuntimeDrain();
  const generation = await handoff;
  expect(generation.processNonce).toBe(oldProcessNonce);
  expect(generation.controlGenerationNonce).toMatch(CANONICAL_TOKEN);
  expect(runtimeResources()).toEqual({
    sessions: 0, contexts: 0, streams: 0, grants: 0,
    writers: 0, timers: 0, workingProfiles: 0,
  });
});

test("exact handoff replay is idempotent and concurrent takeover is fenced", async () => {
  pauseRuntimeDrain();
  const winner = state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  );
  await runtimeDrainStarted();
  await expect(state.createControlGeneration(
    apiBRequest, liveRequestContextB, drainRuntime,
  ))
    .rejects.toMatchObject({ category: "control_generation_in_progress" });
  releaseRuntimeDrain();
  const accepted = await winner;
  await expect(state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  ))
    .resolves.toEqual(accepted);
  expect(drainRuntime).toHaveBeenCalledTimes(1);
});

test("replacement adopts one pre-mint drain after owner transport dies", async () => {
  pauseRuntimeDrain();
  const old = state.createControlGeneration(
    apiARequest, requestContextA, drainRuntime,
  );
  await runtimeDrainStarted();
  requestContextA.abortTransport();
  const replacement = state.createControlGeneration(
    apiBRequest, requestContextB, drainRuntime,
  );
  releaseRuntimeDrain();
  await expect(old).rejects.toMatchObject({
    category: "control_generation_superseded",
  });
  await expect(replacement).resolves.toMatchObject({
    apiInstanceId: apiBRequest.apiInstanceId,
  });
  await expect(state.createControlGeneration(
    apiARequest, retriedRequestContextA, drainRuntime,
  )).rejects.toMatchObject({ category: "control_generation_superseded" });
  expect(drainRuntime).toHaveBeenCalledTimes(1);
});

test("multiple orphan replacements share one drain and only latest mints", async () => {
  pauseRuntimeDrain();
  const a = state.createControlGeneration(
    apiARequest, requestContextA, drainRuntime,
  );
  await runtimeDrainStarted();
  requestContextA.abortTransport();
  const b = state.createControlGeneration(
    apiBRequest, requestContextB, drainRuntime,
  );
  requestContextB.expireDeadline();
  const c = state.createControlGeneration(
    apiCRequest, requestContextC, drainRuntime,
  );
  releaseRuntimeDrain();
  await expect(a).rejects.toMatchObject({
    category: "control_generation_superseded",
  });
  await expect(b).rejects.toMatchObject({
    category: "control_generation_superseded",
  });
  await expect(c).resolves.toMatchObject({
    apiInstanceId: apiCRequest.apiInstanceId,
  });
  expect(state.controlGenerationMintCount()).toBe(1);
  expect(drainRuntime).toHaveBeenCalledTimes(1);
});

test("terminal drain failure replays exactly and fresh tuple fully redrains", async () => {
  const firstFailure = await captureRejection(state.createControlGeneration(
    apiARequest, liveRequestContextA, failDrainAfterPartialClose,
  ));
  expect(firstFailure).toEqual({
    category: "control_generation_drain_failed",
    detail: "close_failed",
  });
  expect(state.currentControlGeneration()).toBeNull();
  expect(state.readyHealth().status).toBe("unready");
  const replayFailure = await captureRejection(state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  ));
  expect(replayFailure).toEqual(firstFailure);
  expect(failDrainAfterPartialClose).toHaveBeenCalledTimes(1);
  expect(drainRuntime).not.toHaveBeenCalled();

  const replacement = await state.createControlGeneration(
    apiBRequest, liveRequestContextB, fullInventoryDrain,
  );
  expect(fullInventoryDrain.inventory()).toEqual(allRuntimeRegistryKinds);
  expect(fullInventoryDrain.reusedPriorProgress()).toBe(false);
  expect(fullInventoryDrain.alreadyClosedResourcesConverged()).toBe(true);
  expect(replacement.apiInstanceId).toBe(apiBRequest.apiInstanceId);
  expect(state.controlGenerationMintCount()).toBe(1);
  await expect(state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  )).rejects.toEqual(firstFailure);
});

test("failed replacement cannot resurrect its superseded predecessor", async () => {
  pauseRuntimeDrain();
  const old = state.createControlGeneration(
    apiARequest, requestContextA, sharedDrainThatWillFail,
  );
  await runtimeDrainStarted();
  requestContextA.abortTransport();
  const replacement = state.createControlGeneration(
    apiBRequest, liveRequestContextB, sharedDrainThatWillFail,
  );
  rejectRuntimeDrain();
  await expect(old).rejects.toMatchObject({
    category: "control_generation_superseded",
  });
  await expect(replacement).rejects.toMatchObject({
    category: "control_generation_drain_failed",
  });
  await expect(state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  )).rejects.toMatchObject({ category: "control_generation_superseded" });
  expect(state.currentControlGeneration()).toBeNull();
  expect(sharedDrainThatWillFail).toHaveBeenCalledTimes(1);
});

test("failed tombstone consumes final history slot", async () => {
  await seedAcceptedControlGenerationTombstones(1_023);
  const failure = await captureRejection(state.createControlGeneration(
    apiARequest, liveRequestContextA, failDrainInvariant,
  ));
  expect(failure.category).toBe("control_generation_drain_failed");
  await expect(state.createControlGeneration(
    apiBRequest, liveRequestContextB, drainRuntime,
  )).rejects.toMatchObject({
    category: "control_generation_history_exhausted",
  });
  await expect(state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  )).rejects.toEqual(failure);
  expect(drainRuntime).not.toHaveBeenCalled();
});

test("history capacity cannot replace an orphan or start another drain", async () => {
  await seedAcceptedControlGenerationTombstones(1_023);
  pauseRuntimeDrain();
  const orphan = state.createControlGeneration(
    apiARequest, requestContextA, drainRuntime,
  );
  void orphan.catch(() => undefined);
  await runtimeDrainStarted();
  requestContextA.abortTransport();
  await expect(state.createControlGeneration(
    apiBRequest, requestContextB, drainRuntime,
  )).rejects.toMatchObject({
    category: "control_generation_history_exhausted",
  });
  releaseRuntimeDrain();
  await runtimeDrainSettled();
  expect(state.currentHandoffOwner()).toMatchObject({
    tuple: apiARequest,
    orphaned: true,
    phase: "pre_mint",
  });
  await expect(state.createControlGeneration(
    apiARequest, retriedRequestContextA, drainRuntime,
  )).rejects.toMatchObject({ category: "control_generation_in_progress" });
  expect(state.currentControlGeneration()).toBeNull();
  expect(drainRuntime).toHaveBeenCalledTimes(1);
});

test("new API generation permits a changed digest after complete drain", async () => {
  const first = await reconcileReadyGeneration(state, apiARequest, digestA);
  const second = await state.createControlGeneration(
    apiBRequest, liveRequestContextB, drainRuntime,
  );
  expect(second.processNonce).toBe(first.processNonce);
  await expect(state.reconcile(
    requestFor(second, digestB), reconcileOnce,
  )).resolves.toMatchObject({ snapshotDigest: digestB });
});

test("old handoff replay is tombstoned and cannot replace current generation", async () => {
  const a = await state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  );
  const b = await state.createControlGeneration(
    apiBRequest, liveRequestContextB, drainRuntime,
  );
  await expect(state.createControlGeneration(
    apiARequest, liveRequestContextA, drainRuntime,
  ))
    .resolves.toEqual(a);
  expect(state.currentControlGeneration()).toEqual(b);
  expect(drainRuntime).toHaveBeenCalledTimes(2);
  expect(() => state.requireReady(a)).toThrow(expect.objectContaining({
    category: "control_generation_mismatch",
  }));
});

test("handoff history fails closed at its process-lifetime bound", async () => {
  await seedAcceptedControlGenerationTombstones(1_024);
  await expect(state.createControlGeneration(
    unknownApiRequest, liveRequestContext, drainRuntime,
  ))
    .rejects.toMatchObject({
      category: "control_generation_history_exhausted",
    });
  await expect(state.createControlGeneration(
    knownReplayRequest, liveRequestContext, drainRuntime,
  ))
    .resolves.toEqual(knownHistoricalResult);
  expect(drainRuntime).not.toHaveBeenCalled();
});

test("reconcile rejects draining before filesystem execution", async () => {
  const state = createReadyStartupState();
  state.beginDraining();
  await expect(state.reconcile(validRequest, reconcileOnce))
    .rejects.toMatchObject({ category: "reconciliation_required" });
  expect(reconcileOnce).not.toHaveBeenCalled();
  expect(state.readyHealth().status).toBe("unready");
});

test("in-flight reconciliation cannot cache readiness after draining", async () => {
  const callback = deferred<ReconciliationResultV1>();
  const state = createStartupState();
  const attempt = state.reconcile(validRequestFor(state), () => callback.promise);
  await callbackStarted();
  state.beginDraining();
  callback.resolve(validResultFor(state));
  await expect(attempt).rejects.toMatchObject({
    category: "reconciliation_required",
  });
  expect(state.readyHealth().status).toBe("unready");
});

test("cached same-digest success cannot return after draining", async () => {
  const state = createStartupStateWithCachedReturnPause();
  await state.reconcile(validRequestFor(state), reconcileOnce);
  const replay = state.reconcile(validRequestFor(state), reconcileOnce);
  await state.cachedReturnReached();
  state.beginDraining();
  state.releaseCachedReturn();
  await expect(replay).rejects.toMatchObject({
    category: "reconciliation_required",
  });
  expect(reconcileOnce).toHaveBeenCalledTimes(1);
  expect(state.readyHealth().status).toBe("unready");
});
```

Add named startup-state cases for:

- synchronous drain callback reentry and synchronous shutdown after callback
  invocation; assert the active wave/shared deferred was already published,
  only one drain exists, and no wave is overwritten;
- synchronous reconciliation callback reentry and shutdown; assert the
  reconciliation flight/shared deferred was already published, exact requests
  join once, and no callback can publish readiness after abort;
- an unknown API identity/key collision with 1,023 entries versus at the 1,024
  cap; assert tentative capacity reservation precedes collision semantics,
  below-cap collision releases its slot, and at-cap result is
  `control_generation_history_exhausted`;
- known completed, superseded, and failed exact replay at capacity; failed
  replacement consuming the final slot; orphan replacement from exactly 1,023
  accepted tuples becoming tuple 1,024 on the same drain; unknown orphan
  replacement rejected from exactly 1,024 without owner change or another
  drain; and completed A→B→replay-A leaving B current;
- exact request-category precedence: over-25,000 references or over-16-MiB body
  is `reconciliation_snapshot_too_large`; malformed schema/path/checksum/alias/
  digest is `reconciliation_snapshot_invalid`; structurally valid stale process
  is `reconciliation_nonce_mismatch`; current-process stale generation is
  `control_generation_mismatch`; every rejection invokes no filesystem callback;
- bounded captured logs for all failure branches with no path, checksum, nonce,
  tuple key, private URL, profile/browser identity, capability, or grant.

Assert two process instances receive different 43-character process nonces;
multiple handoffs in one process retain that process nonce and receive
different 43-character generation nonces. Wrong/stale process or generation
performs no callback. Same API identity with a different idempotency key,
reused key with another API identity, pre-mint drain failure, and shutdown
during handoff all fail closed. Test transport abort and request deadline
expiry separately. A live owner cannot be stolen; an orphan replacement adopts
one shared drain; superseded handlers/retries never mint; multiple sequential
owner crashes still invoke the physical drain once. A physical drain failure
caches one immutable typed terminal tombstone; exact replay is identical and a
fresh tuple succeeds only after a new full-inventory idempotent redrain. Failed
tombstones consume history capacity and never revive superseded tuples.
Service-process crash
starts a fresh identity with no pending wave. `beginDraining()` closes
admission permanently; health
objects contain no path, checksum, key, URL, public browser ID, capability, or
unscoped control-generation nonce. Unknown tuples reserve history before
collision evaluation; known exact replay remains deterministic at capacity.
Both handoff and reconciliation publish their flight/deferred before invoking
user callbacks, so synchronous reentry and shutdown cannot duplicate work.

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
    admission: fixture.admission,
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  });
  expect(result).toMatchObject({
    retained: 2,
    removed: 1,
    missing: 0,
    corrupt: 0,
    ready: true,
  });
  expect(await fixture.exists(
    "replay/owner-a/scrape-a/11111111-1111-4111-8111-111111111111.json",
  ))
    .toBe(true);
  expect(await fixture.exists(
    "replay/owner-a/scrape-a/22222222-2222-4222-8222-222222222222.json",
  ))
    .toBe(false);
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
  expect(await fixture.exists(
    "replay/owner-a/scrape-a/22222222-2222-4222-8222-222222222222.json",
  ))
    .toBe(true);
});

test("execution failure changes only the exact planned quarantine entry", async () => {
  const fixture = await createMultipleOrphanFixture();
  fixture.failAfterFirstRename();
  await expect(reconcileBrowserState(fixture.root, fixture.request, fixture.deps))
    .rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
  expect(await fixture.locationOf(fixture.first)).toBe(
    `quarantine/${fixture.processNonce}/${fixture.controlGenerationNonce}/` +
      fixture.first.relativePath,
  );
  expect(await fixture.locationOf(fixture.second)).toBe(
    fixture.second.relativePath,
  );
  expect(fixture.startupState.readyHealth().status).toBe("unready");
  await expect(reconcileBrowserState(fixture.root, fixture.request, fixture.deps))
    .resolves.toMatchObject({ ready: true, removed: 2 });
});

test("equal basenames preserve complete managed source namespaces", async () => {
  const fixture = await createEqualManagedIdentityFixture(
    "33333333-3333-4333-8333-333333333333",
  );
  fixture.failAfterAllQuarantineRenames();
  await expect(reconcileBrowserState(fixture.root, fixture.request, fixture.deps))
    .rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
  expect(fixture.quarantineDestinations()).toEqual([
    `${fixture.quarantine}/replay/owner-a/scrape-a/33333333-3333-4333-8333-333333333333.json`,
    `${fixture.quarantine}/profiles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/committed/33333333-3333-4333-8333-333333333333`,
    `${fixture.quarantine}/profiles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/staging/33333333-3333-4333-8333-333333333333`,
    `${fixture.quarantine}/profiles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/working/33333333-3333-4333-8333-333333333333`,
  ]);
});

test("new process resumes an old-process manifest after crash", async () => {
  const fixture = await crashAfterFirstRenameFixture();
  const restarted = fixture.restartWithNewProcessNonce();
  await expect(reconcileBrowserState(
    restarted.root, restarted.request, restarted.deps,
  )).resolves.toMatchObject({ ready: true });
  expect(await restarted.oldNoncePendingManifestEntries()).toEqual([]);
  expect(await restarted.unrelatedEntryBytes()).toEqual(fixture.originalBytes);
});

test("new API generation resumes old-generation manifest safely", async () => {
  const fixture = await crashAfterFirstRenameFixture();
  const next = fixture.handoffSameProcessToNewApi();
  expect(next.processNonce).toBe(fixture.processNonce);
  expect(next.controlGenerationNonce)
    .not.toBe(fixture.controlGenerationNonce);
  await expect(reconcileBrowserState(
    next.root, next.changedAuthoritativeRequest, next.deps,
  )).resolves.toMatchObject({ ready: true });
  expect(await next.oldGenerationPendingManifestEntries()).toEqual([]);
  expect(await next.authoritativeEntries()).toEqual(next.expectedAuthorities);
  expect(await next.unrelatedEntryBytes()).toEqual(fixture.originalBytes);
});

test("draining stops before the next reconciliation filesystem call", async () => {
  const fixture = await createMultipleOrphanFixture();
  fixture.pauseAfterFirstRenameBeforeFsync();
  const attempt = fixture.startThroughAdmission();
  await fixture.firstRenameCompleted();
  fixture.startupState.beginDraining();
  expect(fixture.reconciliationSignal.aborted).toBe(true);
  fixture.releaseFilesystemPause();
  await expect(attempt).rejects.toMatchObject({
    category: "reconciliation_required",
  });
  expect(fixture.filesystemCallsAfterPause()).toEqual([]);
  expect(fixture.startupState.readyHealth().status).toBe("unready");
});

test("draining aborts an authority walk before any mutation", async () => {
  const fixture = await createStateFixture({ referencedCheckpoint: true });
  fixture.pauseAfterFirstAuthorityRead();
  const attempt = fixture.startThroughAdmission();
  await fixture.firstAuthorityReadCompleted();
  fixture.startupState.beginDraining();
  fixture.releaseFilesystemPause();
  await expect(attempt).rejects.toMatchObject({
    category: "reconciliation_required",
  });
  expect(fixture.filesystemCallsAfterPause()).toEqual([]);
  expect(fixture.mutations()).toEqual([]);
});
```

Add table-driven filesystem cases that use the real Linux implementation, plus
injected syscall boundaries only where a crash point cannot be triggered
portably:

- canonical lowercase profile and generation UUID directory grammar passes;
  a profile authority file, uppercase/noncanonical/wrong UUID, extra namespace
  file, unknown state name, or nested entry outside exact
  `profiles/<profileId>/{committed|staging|working}/<generationId>/` fails before
  mutation;
- checkpoint and profile trees reject path/checksum aliases, traversal,
  absolute/backslash/control paths, symlinks, hard links with `nlink !== 1`,
  sockets, FIFOs, and device/special-file helper branches;
- canonical profile-tree fixtures assert raw UTF-8 path order and exact fixed-
  key entry JSON, mode, size, content SHA, final tree SHA, NFC/path/segment
  bounds, and Task 4 checksum reuse;
- one positive traversal fixture with exactly 25,000 charged entries plus one
  EOF lookahead succeeds. Overflow performs one non-null `Dir.read()` lookahead
  but application code performs zero name/type inspection, yield, retain, sort,
  stat, open, content read, hash, plan, or mutation on it. Assert iterative
  `fs.opendir`, explicit `bufferSize <= 32`, no whole-directory `readdir`, each
  managed root charged once through the global root set, repeated descendant
  walks recharged per yielded descendant, and EOF/ENOENT probes uncharged. Depth
  65 stops before descending; a checkpoint declared above 2 MiB stops before
  content read; one profile file above 64 MiB or cumulative profile bytes above
  256 MiB stops while walking, before later entries are content-read;
- deletion eligibility uses maximum descendant mtime; a young nested file keeps
  an otherwise old generation, while all descendants older than 10 minutes
  permit planning;
- an ancestor directory-to-symlink swap at every component boundary cannot
  redirect authority reads, plan writes, rename, fsync, or delete outside the
  held canonical-root handle; leaf type/identity swaps fail unsafe;
- missing/forged/modified `plan.json`, a modified quarantine destination, an
  unexpected quarantine byte without a manifest, parent identity drift, and
  both-present source/destination fail unsafe without touching either;
- every sibling record and pending entry phase/parent/leaf identity validates
  read-only before any record promotion, repair, mutation, or cleanup; a
  plan-bearing completed state uses held recorded parents or its exact
  completed-cleanup destination-suffix exception, fails unsafe when identity
  drifts or a leaf is present, and accepts its marker only when SHA, retained,
  and removed equal the plan exactly;
- crash after destination-directory removal but before `plan.json` unlink, then
  restart; global validation proves the exact authorized absent suffix from a
  held surviving ancestor and cleanup completes. Ancestor replacement or any
  unauthorized missing parent fails unsafe with every record untouched;
- crash/failure after `plan.tmp` file fsync, plan rename, plan-directory fsync,
  each skeleton-parent fsync, source rename, source-parent fsync,
  destination-parent fsync, delete,
  post-delete destination fsync, `complete.tmp` fsync, completion rename, every
  manifest/`.plans` parent fsync, and each completion-cleanup unlink/rmdir/fsync
  resumes deterministically;
- source-only, destination-only, and both-absent phases produce exact retained/
  removed counts. Delete-then-fsync failure retries that fsync and counts the
  entry once, never zero or twice;
- a current plan stores only newly eligible current entries while persisting the
  unique union count of those entries and pending-old entries. Exactly 25,000
  succeeds; would-be entry 25,001 rejects before plan publication. Pending-old
  paths remain only in old plans, contribute entries but not old aggregate, and
  historical final completion contributes zero;
- plan-first cleanup crashes to one canonical final `complete` record that has
  no path authority. Global zero-leaf/unaccounted-byte and exact-empty-skeleton
  proof permits deleting only it and empty ancestors; bytes outside the closed
  canonical encoding, malformed bytes, manifestless `complete.tmp`, remaining
  content, or unauthorized skeleton fails unsafe without extra record types;
- new process and same-process new generation enumerate only validated old
  manifests after authority validation, finish pending work with exact counts,
  and never rebuild from quarantine destination paths;
- draining between every non-cleanup filesystem await starts no later call,
  but every held descriptor gets a close attempt in raw `finally`; assert zero
  retained handles after abort, open/stat failure, and close-then-throw. A true
  close rejection retains fail-stop ownership and makes no zero-handle claim;
- bounded aggregate success/failure logs redact all paths, checksums, manifest
  content, nonces, IDs, keys, URLs, capabilities, and grants.

Validation or plan-persistence rejection before candidate mutation proves zero
eligible entry changed. Execution failure may change only the exact durable
manifest prefix; every authority and unrelated planned/unplanned entry remains
byte-identical, readiness stays closed, and same tuple/digest retry loads that
manifest and converges.

- [ ] **Step 3: Run focused tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/startup-state.test.ts src/reconciliation.test.ts
```

Expected: FAIL because startup state/reconciliation do not yet satisfy the
prepublished-flight, durable-manifest, procfd-confinement, grammar, bound, and
crash-recovery contract.

- [ ] **Step 4: Implement process-local startup state**

Expose this closed interface from `startup-state.ts`:

```ts
export type StartupAdmission = {
  processNonce: string;
  createControlGeneration(
    request: CreateControlGenerationV1,
    context: ControlGenerationRequestContext,
    drainRuntime: (admission: ControlGenerationDrainAdmission) => Promise<void>,
  ): Promise<ControlGenerationV1>;
  requireReady(binding: ControlGenerationBinding): {
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: string;
  };
  liveHealth(): LiveDiscoveryV1;
  scopedLiveHealth(binding: ControlGenerationBinding): ScopedLiveHealthV1;
  readyHealth(): ReadyHealthV1 | UnreadyHealthV1;
  reconcile(
    request: ReconciliationRequestV1,
    execute: (
      request: ReconciliationRequestV1,
      admission: ReconciliationExecutionAdmission,
    ) => Promise<ReconciliationResultV1>,
  ): Promise<ReconciliationResultV1>;
  beginDraining(): void;
};

// Internal server wiring only; omitted from the public barrel. Task 4 supplies
// InternalReconciliationOutcome and the generation-scoped ProfileStore factory.
export type InternalStartupAdmission = StartupAdmission & {
  reconcileWithAuthority(
    request: ReconciliationRequestV1,
    execute: (
      request: ReconciliationRequestV1,
      admission: ReconciliationExecutionAdmission,
    ) => Promise<InternalReconciliationOutcome>,
  ): Promise<ReconciliationResultV1>;
};

export type InternalProfileStoreFactory = (
  root: AnchoredProfileRoot,
  binding: ReadyProfileRootBinding,
) => Promise<ProfileStore>;

export type ReconciliationExecutionAdmission = {
  readonly signal: AbortSignal;
  assertAdmitted(): void;
};

export type ControlGenerationBinding = {
  processNonce: string;
  controlGenerationNonce: string;
};

export type ControlGenerationDrainAdmission = {
  // Aborted only by service shutdown or terminal wave failure, never by one
  // owner request closing or being superseded.
  readonly signal: AbortSignal;
  assertWaveActive(): void;
};

export type ControlGenerationRequestContext = {
  readonly transportSignal: AbortSignal;
  readonly deadlineAtMs: number;
};

export function createStartupState(deps?: {
  randomBytes?: (size: number) => Buffer;
}): StartupAdmission;

// Internal server wiring only; Task 4 adds this factory.
export function createInternalStartupState(deps: {
  randomBytes?: (size: number) => Buffer;
  createProfileStore: InternalProfileStoreFactory;
}): InternalStartupAdmission;
```

Generate exactly 32 bytes with `node:crypto.randomBytes` for process identity
and each successful control generation, encode unpadded base64url, and never
persist or log either nonce. Process nonce never changes within the process.
Serialize control handoff and reconciliation separately. Under the handoff
mutex, keep exactly one service-owned wave with current tuple owner, request
transport signal, absolute deadline, shared drain promise, and phase
`pre_mint | minted | failed`. Starting a wave synchronously closes admission, aborts
active reconciliation, clears readiness/cache, creates its deferred, and
publishes the complete wave under the mutex before invoking the bounded
runtime-drain callback once. Invoke the callback only after publication and
settle the deferred exactly once, including synchronous throw. Synchronous
reentry or shutdown therefore observes the same wave and cannot duplicate or
overwrite it. The shared promise continues if its owner request dies; its
`ControlGenerationDrainAdmission` is wave-scoped and aborts only for service
shutdown or terminal drain failure, never owner replacement. Before
mint, an authenticated new tuple may replace only an owner whose
transport is aborted/closed or deadline expired; it atomically adopts the same
promise and tombstones the old tuple as `control_generation_superseded`.
Every handler rechecks ownership under the mutex after awaits and immediately
before mint, so an old handler/retry cannot mint or regain ownership. A live
owner returns `control_generation_in_progress` to other tuples. Only the
current live owner mints after the shared drain proves every resource closed.
If drain rejects, atomically store immutable
`control_generation_drain_failed` with one internal allowlisted detail, clear active
ownership, and never mint. Exact replay returns that same cached failure.
Only a fresh tuple may begin a new full-inventory idempotent redrain; do not
reuse partial progress or the rejected promise.
After mint, forbid supersession and cache the result before response delivery,
so caller timeout/loss converges by exact replay; the next different tuple
starts a normal new full-drain wave. Enforce exact collision rules from Locked
private contracts. Retain at most 1,024
pending/superseded/failed/completed tuple tombstones without eviction for
process lifetime. Under the mutex, look up known exact tuple replay first. For
every unknown tuple, check and tentatively reserve history capacity before
API-identity/idempotency-key collision semantics. At capacity, an unknown tuple
returns `control_generation_history_exhausted` even if one component collides;
known completed, superseded, or failed replay remains deterministic. Below
capacity, collision rejection releases the tentative slot. An unknown tuple
cannot adopt an orphan drain or start after failure without a reserved slot.
Use one shared, non-evicting history count; do not transfer an orphan owner's
slot or maintain a separate superseded-tombstone allowance. With exactly 1,023
accepted tuples, an unknown orphan replacement may reserve and become tuple
1,024. With exactly 1,024, reject it before changing owner or history state.

Validate process and control generation before calling filesystem code. Cache
only a successful exact `(processNonce,controlGenerationNonce,digest)` result;
preserve current readiness on a conflicting same-generation replay. A new
completed handoff clears the prior cache and permits one different digest. A
failed attempt remains retryable and unready. `requireReady(binding)` throws
`control_generation_mismatch` for stale generation and
`reconciliation_required` outside `ready` or after draining.
`reconcile()` creates one private `AbortController`, shared deferred, and
complete flight record per accepted execution, then publishes that flight
before invoking the execute callback. Exact concurrent or synchronous reentry
joins the deferred. Synchronous throw settles it once; synchronous draining
sees and aborts the published flight. It
passes its signal plus `assertAdmitted()` checkpoint to the callback. It
rejects draining before process/generation/digest callback invocation and rechecks after
awaited filesystem work before caching success. It also rechecks draining
immediately before returning an existing same-generation/digest cached
success.
`beginDraining()` aborts the controller synchronously before returning. No
accepted, cached, or in-flight
reconciliation may start a later filesystem call, publish a cached result, or
return readiness to true.

Reject category precedence before filesystem execution: over-25,000 references
or over-16-MiB encoded body is `reconciliation_snapshot_too_large`; malformed
JSON/schema, path, checksum, alias, or digest is
`reconciliation_snapshot_invalid`; a structurally valid stale process is
`reconciliation_nonce_mismatch`; a valid current-process stale generation is
`control_generation_mismatch`.

- [ ] **Step 5: Implement validate-plan-quarantine reconciliation**

Expose this filesystem-only boundary:

```ts
export type ReconciliationDependencies = {
  admission: ReconciliationExecutionAdmission;
  now?: () => Date;
  gracePeriodMs?: number;
  maxManagedEntries?: number; // test-only lower bound, clamped to 1..25_000
  correlationId?: string;
  logger?: Pick<Logger, "info" | "error">;
};

export function canonicalizeReconciliationSnapshot(
  references: readonly ReconciliationReferenceV1[],
): { canonicalJson: string; snapshotDigest: string };

export async function reconcileBrowserState(
  canonicalRoot: string,
  request: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
): Promise<ReconciliationResultV1>;
```

First parse the complete closed request, recompute digest, and validate every
authority. Apply exact category precedence before filesystem code: excess
references/body is `reconciliation_snapshot_too_large`; malformed schema,
path, checksum, alias, or digest is `reconciliation_snapshot_invalid`; valid
stale process is `reconciliation_nonce_mismatch`; valid current-process stale
generation is `control_generation_mismatch`.

`canonicalRoot` is the configured `LOCAL_BROWSER_STATE_ROOT` itself; no route,
snapshot, API, harness request, or namespace parameter can replace or extend
it. Require Linux `/proc/self/fd` anchoring. Before any snapshot or filesystem
state work, open `/`, then each absolute `canonicalRoot` component through
`/proc/self/fd/<parentFd>/<segment>` with `O_DIRECTORY | O_NOFOLLOW`. Retain
the full slash→root chain, validate each parent entry and child dev/ino/mode
around every await, and capture evidence only from those exact handles.
Unavailable procfs resolution or any capture-time component swap is
`reconciliation_filesystem_unsafe` and remains unready with zero state work.
Create/open quarantine parents from the held root the same way. Hold source and
destination parent handles through rename, both parent fsyncs, delete, and final
fsync. Rename/remove only procfd-anchored parent/leaf paths, never original
validated strings. Revalidate source identity immediately before rename and
destination identity immediately after move and before delete. Ancestor
symlink swaps cannot redirect outside root; any leaf/type/identity change fails
unsafe.

Before and after every non-cleanup filesystem await, call both
`admission.signal.throwIfAborted()` and `admission.assertAdmitted()`. Put every
handle close in raw `finally` and perform it unconditionally without admission
checks; abort never suppresses required descriptor cleanup.

Checkpoint grammar is exactly
`replay/<owner>/<scrape>/<canonical-lowercase-uuid>.json` and authority is one
regular file at most 2 MiB before read. Profile grammar is exactly
`profiles/<canonical-lowercase-profile-uuid>/`
`{committed|staging|working}/<canonical-lowercase-generation-uuid>/`; authority
is that generation directory, never a file. Direct children of `profiles/`
must be profile UUID directories; direct children of each profile must be only
the three state directories; direct children of each state must be generation
UUID directories. Unknown files/names at those namespace levels fail closed.
Inside a generation, bounded regular files/directories form the canonical tree.
Reject symlinks, root
escapes, sockets, FIFOs, devices/special files, and every regular file with
`nlink !== 1`.

Keep Task 3's existing pathname-facing canonical profile-tree API, but factor
its private Budget, held walker, encoder, hash, and evidence engine for Task 4's
new opaque held-root adapters. Task 4 never calls the pathname-facing helper,
and no second checksum implementation exists. Walk to maximum depth 64 and sort root plus descendants by raw UTF-8 relative-
path bytes. Require NFC paths, at most 255 UTF-8 bytes per segment and 1,024 per
relative path. Encode the root with `path:""`. Serialize exact whitespace-free
UTF-8 fixed-key JSON shaped as
`{"version":1,"entries":[{"path":"","type":"directory","mode":448,"size":0,"sha256":null}]}`.
Every entry uses key order
`path,type,mode,size,sha256`; mode is low permission bits as decimal,
directories use zero size/null SHA, and files use exact size/lowercase content
SHA-256. Tree checksum is SHA-256 of those bytes. Limit each profile regular
file to 64 MiB and total generation file bytes to 256 MiB while streaming.
Check checkpoint canonical JSON SHA over storage-state-only bytes; never expect
a checkpoint envelope on disk.

Create one global managed-entry counter per reconciliation and never reset it.
Authority walks, namespace enumeration, candidate identity walks, planning
revalidation, manifest recovery, and retry-phase validation all consume from
the same 25,000 total. Enumerate iteratively with `fs.opendir` and an explicit
`bufferSize` no greater than 32; never use whole-directory `readdir`. Below the
cap, charge each non-null `Dirent` immediately after `Dir.read()` and before any
yield or processing. At the cap, permit a `Dir.read()` lookahead only to
distinguish uncharged EOF from overflow. A non-null overflow fails immediately
and is never yielded, name/type-inspected by application code, retained, sorted,
statted, opened, content-read, hashed, planned, or mutated. Node/libuv prefetch
is bounded by the fixed buffer and remains outside the processed-entry count.

A set keyed by `replay`, `profiles`, and `quarantine` charges each successfully
entered managed root exactly once globally. ENOENT roots, absent-entry probes,
and EOF lookaheads do not charge. Repeated descendant walks recharge every
non-null yielded descendant, including plan manifests, temp files, completion
markers, and profile descendants. In this budget, "read" means file-content
read, not enumeration lookahead. Test-only lower limits may exercise boundaries;
production callers cannot raise exact caps. This filesystem traversal budget is
independent of the separate captured-workset cardinality cap. Only after all
authorities pass may enumeration proceed into deletion planning.
Retain every reference, including cleanup intents and active/latest profile
generations supplied by API. Eligible deletion requires recognized ownership,
absence from snapshot, and age greater than 10 minutes. Directory age is its
maximum descendant mtime including the root, not only root mtime. Build and
freeze a sorted deletion plan. Each item records full root-relative source
path, recognized namespace/type, immutable file/tree identity SHA-256, byte
count, and deterministic destination:
`quarantine/<processNonce>/<controlGenerationNonce>/`
`<full-root-relative-source-path>`. Preserve every
source path segment (`replay/<owner>/<scrape>/...`,
`profiles/<id>/committed/...`, `staging/...`, `working/...`) rather than
basename or a lossy encoding. Validate
each segment with `RelativeStatePath`, create parents one segment at a time
under held directory handles, and reject traversal or root escape.

Before any record promotion, durability repair, candidate mutation, or cleanup,
read-only enumerate every plan directory and parse every temporary or final
manifest and completion marker. Validate all quarantine bytes and directories
against those records. For every pending plan entry validate exact observed
source/destination phase, both recorded parent identities, leaf type, and
content/tree identity. For every plan-bearing completed state, first require a
final `complete` whose manifest SHA matches exact plan bytes and whose counts
satisfy
`complete.retained === plan.retained` and
`complete.removed === plan.removed`. Then open its recorded source parent
through a held procfd handle, revalidate identity, and prove the source leaf
absent. Open the recorded destination parent through a held procfd handle,
revalidate identity, and prove its leaf absent.
The only missing-destination-parent exception is a suffix already removed by
durable completed-plan cleanup: from the nearest surviving recorded or
authorized ancestor, walk with held procfd handles and prove every absent suffix
component exactly matches the manifest's authorized destination hierarchy, with
no alternate leaf or unaccounted byte. This exception never applies to pending
state, `complete.tmp`, an invalid marker, a missing source parent, or an
arbitrary missing destination parent. Reject the complete set without mutation
if any record, entry, or sibling is invalid. A final completion-only record has
no paths and cannot authenticate its deleted plan; it is never path authority.

After that read-only validation, capture one immutable workset for this logical
reconciliation. Its cardinality is the union of newly eligible current entries
and unique entries from every plan-bearing manifest pending at capture. Reject
before plan publication when adding would-be entry 25,001; exactly 25,000
succeeds. A manifest already completed at capture, including completion-only
state, is historical cleanup and contributes zero. A pending old plan
contributes its entries only, never its own aggregate `removed`, so nested
historical reconciliations cannot double count. Reject duplicate workset source
or destination paths as unsafe; never silently deduplicate them.

Before the first candidate mutation, persist an immutable manifest at exact
grammar `quarantine/<processNonce>/<controlGenerationNonce>/.plans/`
`<snapshotDigest>/plan.json`. Its directory permits only `plan.tmp`,
`plan.json`, `complete.tmp`, and `complete`; no cleanup-copy file is permitted.
The fixed-key canonical JSON, bounded to 64 MiB, contains version, process
nonce, control-generation nonce, snapshot digest, retained count, removed
count, and sorted entries. The current plan's `entries` contains only newly
eligible current candidates. Pending-old entries remain solely in their old
manifests and affect only the current plan's `removed` cardinality; never copy
their path authority into the current plan. Every current entry contains
source/destination relative paths, recognized type, immutable identity SHA,
bytes, source and destination parent identities shaped as
`{path,dev,ino,mode}`, and phase model
`source_only | destination_only | both_absent`; both-present is always invalid.
Checkpoint identity hashes type/mode/size/content SHA. Profile identity is the
shared canonical tree SHA plus byte count.

Lock exact manifest field names and order:

```ts
type ReconciliationPlanV1 = {
  version: 1;
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
  retained: number;
  removed: number;
  entries: Array<{
    sourcePath: string;
    destinationPath: string;
    recognizedType: "replay_checkpoint" | "profile_generation";
    identitySha256: string;
    bytes: number;
    sourceParent: { path: string; dev: string; ino: string; mode: number };
    destinationParent: { path: string; dev: string; ino: string; mode: number };
    phaseModel: 1;
  }>;
};
```

Sort entries by raw UTF-8 `sourcePath`, then `destinationPath`; encode `dev` and
`ino` as canonical unsigned decimal strings. Checkpoint `identitySha256` hashes
exact fixed-key JSON `type,mode,size,contentSha256`; profile identity is the
canonical tree SHA. `phaseModel:1` defines the observed source/destination
phase transitions below; phase is derived from filesystem state and never
mutated in the manifest. `removed` is a nonnegative safe integer no greater
than 25,000 and locks the captured workset size. Exact retry reads it from the
same manifest and never recomputes it from later manifest states.

Write `plan.tmp` using `O_CREAT | O_EXCL | O_NOFOLLOW` mode 0600, fsync the
file, atomically rename to `plan.json`, then fsync the plan directory and
`.plans` parent through held handles. Quarantine parent creation may precede
manifest publication, but every created directory is immediately opened and
its held parent fsynced; fsync the complete empty skeleton before `plan.tmp`.
No candidate may move/delete first. Crash after temp
fsync validates and publishes those exact bytes. Same tuple/digest retry loads
and validates the durable temp/manifest instead of rebuilding from mutable
quarantine.

Before `plan.tmp` exists, allow only the exact empty directory skeleton created
for that tuple/digest. Retry revalidates source and parent identities before
creating the manifest. Any destination file/tree, nonempty candidate directory,
or unexpected entry without valid `plan.tmp`/`plan.json` is no-manifest partial
quarantine and fails unsafe untouched.

Execute sorted entries with exact phases:

- source-only: revalidate identity, rename through held parent handles, fsync
  both source and destination parents, revalidate moved identity, delete, then
  fsync destination parent;
- destination-only: validate recorded identity, fsync both source and
  destination parents before delete, delete, then fsync destination parent;
- both-absent: fsync destination parent before recording/counting completion;
- both-present or any source/destination/parent/type/identity mismatch: fail
  unsafe without touching either.

Delete followed by destination-fsync failure remains incomplete; retry repeats
that fsync and counts the item once. Keep `plan.json` until every delete and
required fsync completes. Then create `complete.tmp` with
`O_CREAT | O_EXCL | O_NOFOLLOW` mode 0600, write and fsync exact fixed-key bytes
`{"version":1,"manifestSha256":"<sha256>","retained":N,"removed":N}`,
rename it to `complete`, and fsync the plan directory. A crash with only
`complete.tmp` validates and publishes those exact bytes. Exact retry validates
plan plus marker and returns identical counts. In every plan-bearing state,
require the marker manifest SHA-256 to match the exact plan bytes,
`complete.retained === plan.retained`, and
`complete.removed === plan.removed`.

After current authority validation, enumerate old process/generation work only
through exact validated manifests. Verify every quarantine byte against its
manifest identity; modified/forged/missing-manifest partial quarantine fails
unsafe untouched. A later generation may finish an older pending manifest only
when its authority proves every source unreferenced. It never reconstructs from
destination paths, nests old quarantine, or restores bytes.

A later reconciliation may clean a validated older completed plan only after
the final marker exact-binds it and a held recorded source parent proves source
absence. Normally, a held recorded destination parent must match and prove its
leaf absent; fsync both held parents before removing any still-existing empty
destination directory and keep relevant handles through removal and held-parent
fsync. After a cleanup crash, the completed-cleanup exception may replace only
that destination-parent proof: a held nearest surviving recorded or authorized
ancestor must prove the exact manifest-authorized destination suffix absent
with no alternate leaf or unaccounted byte. Fsync the source parent and that
ancestor before continuing. Then unlink `plan.json`, fsync the plan directory,
unlink `complete`, and fsync again; finally remove empty digest/`.plans`/
generation/process directories bottom-up and fsync each held parent.

A crash between record unlinks leaves exactly one final `complete` file. That
file cannot authenticate its deleted plan and is not path authority. Accept it
only after the global read-only pass proves its process/generation contains zero
quarantine leaves and zero unaccounted bytes. Its only remaining hierarchy must
be the exact otherwise-empty authorized
`.plans/<snapshotDigest>/complete` skeleton. It may authorize deletion only of
itself and now-empty digest/`.plans`/generation/process ancestors, never managed
or quarantine content, and contributes zero. Its closed canonical fields,
bounds, mode, and link count are syntax checks only; SHA/count values cannot
authenticate the deleted plan. Forged-marker rejection applies to plan-bearing
states where exact plan bytes remain. Arbitrary bytes outside that one canonical
encoding, malformed bytes, a `complete.tmp` without a manifest, or
completion-only state with any quarantine content or unauthorized skeleton
fails unsafe. No `cleanup.tmp`, `cleanup`, or other copied manifest record
exists.

Define `retained` as unique authority paths validated. Define `removed` as the
pending-only workset captured and stored in the current immutable plan. Each
entry counts once even if already both-absent or post-delete/pre-fsync at
capture, or if it completes during this attempt. A manifest with valid final
completion before capture is historical and contributes zero. Never add an old
plan's aggregate `removed`; count only its unique entries when it was pending at
capture. Exact retry returns the stored value rather than deriving history from
later completion states.

The mutation order is exact: validate authority; enumerate and read-only
validate every record, sibling, phase, and identity; capture the pending-only
workset; publish or validate the current immutable plan; promote valid temporary
records and repair their required durability; execute and complete captured old
pending plans; execute and complete the current plan last; then clean historical
and newly completed old plans only after current completion is durable. Return
the current completion's retained/removed fields. A crash at any step resumes
from these durable states without changing the captured count.

Zero-change applies through complete validation and durable manifest
publication. Once candidate execution begins, an error may change only the
exact manifest prefix, keeps readiness unready, and leaves every authority,
unrelated entry, and unexecuted item unchanged. Never rollback rename after an
fsync/error boundary; exact retry converges from manifest phase. Admission
abort maps to `reconciliation_required`, not cleanup failure, and preserves
durable progress. The service route passes the exact admission object from
`StartupAdmission.reconcile()` without replacing its signal.

Log one bounded aggregate record containing category, correlation ID, state,
counts, duration, and result. Test captured logs contain none of request paths,
reference/profile/browser IDs, hashes, nonce, service key, database/private URL,
capability, or grant.

- [ ] **Step 6: Run reconciliation tests and package build**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/startup-state.test.ts src/reconciliation.test.ts
corepack pnpm build
```

Expected: tests PASS for prepublished reentrant handoff/reconciliation flights,
capacity-before-collision ordering, acceptance of an unknown orphan replacement
as tuple 1,024 from exactly 1,023 accepted tuples, rejection without owner
change from exactly 1,024, exact request categories, fail-before-mutation,
procfd confinement/swap resistance, strict profile grammar/shared tree identity,
early bounds, descendant age, durable manifest publication, read-only validation
of every record and pending phase before mutation, held-parent completed absence
and exact completion equality, completed-cleanup absent-suffix restart and
ancestor-replacement rejection, current-only plan entries, pending-only
aggregate count persistence at exact 25,000/25,001 bounds, historical-count
exclusion, limited completion-only cleanup without extra records, positive
exact-cap filesystem traversal with bounded iterative `fs.opendir`, EOF/overflow
lookahead, zero overflow processing, and root/descendant charging, every rename/
delete/fsync/completion crash phase, old-manifest recovery, deterministic
counts, abort-time handle closure, namespace isolation, and redaction; build
PASS. Only the four Task 3 files above are implementation scope.

- [ ] **Step 7: Commit startup reconciliation**

```bash
git add apps/browser-service/src/startup-state.ts apps/browser-service/src/startup-state.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: reconcile browser state before readiness" -m "Bind readiness to one control generation and authoritative snapshot.

Persist validated cleanup manifests before procfd confinement.
Resume exact crash phases after filesystem failure or restart."
```

### Task 4: Add immutable profiles and persistent session lifecycle

**Files:**
- Create: `apps/browser-service/src/profile-store.ts`
- Create: `apps/browser-service/src/profile-store.test.ts`
- Create: `apps/browser-service/src/session-registry.ts`
- Create: `apps/browser-service/src/session-registry.test.ts`
- Create: `apps/browser-service/src/replay-restore.ts`
- Create: `apps/browser-service/src/replay-restore.integration.test.ts`
- Modify: `apps/browser-service/src/egress-proxy.ts`
- Modify: `apps/browser-service/src/egress-proxy.test.ts`
- Modify: `apps/browser-service/src/reconciliation.ts`
- Modify: `apps/browser-service/src/reconciliation.test.ts`
- Modify: `apps/browser-service/src/startup-state.ts`
- Modify: `apps/browser-service/src/startup-state.test.ts`

- [ ] **Step 1: Write profile crash-boundary and TTL tests**

```ts
import { describe, expect, test, vi } from "vitest";

test("publishes a writer generation through prepare and finalize", async () => {
  const work = await store.createWorkingCopy(profileId, null, "writer", sessionId);
  await heldFixtureWriter.writeFileExclusive(work, "Cookies", "state");
  expect(work).not.toHaveProperty("path");
  const prepared = await store.prepareWorkingCopy(work);
  expect(await store.hasCommitted(prepared.generationId)).toBe(false);
  const committed = await store.finalizePreparedGeneration(prepared);
  expect(committed.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(await store.hasCommitted(prepared.generationId)).toBe(true);
});

test("rejects an empty writer schema before prepare or publication", async () => {
  const work = await store.createWorkingCopy(profileId, null, "writer", sessionId);
  await expect(store.prepareWorkingCopy(work)).rejects.toMatchObject({
    category: "browser_unavailable",
    detail: "profile_schema_empty",
  });
  expect(store.profileLifecycleCalls()).toEqual([]);
  expect(await store.listWorking()).toEqual([work.generationId]);
  await store.discardWorkingCopy(work);
});

test("held profile operations detect restored ancestor swaps", async () => {
  for (const consumer of ["reconciliation-held-api", "profile-store"] as const) {
    for (const operation of [
      "canonicalize", "sync", "copy", "state-transition",
    ] as const) {
      for (const component of [
        "root", "profiles", "profile", "state", "generation",
      ] as const) {
        const fixture = await createHeldProfileFixture({ consumer, operation });
        const attack = fixture.transientSwapAndRestore(component);
        const outcome = await captureOutcome(fixture.run(attack.hooks));
        if (operation === "state-transition") {
          expect(outcome).toMatchObject({
            status: "rejected",
            category: "reconciliation_filesystem_unsafe",
          });
        } else {
          expect(outcome).toMatchObject({
            status: "succeeded",
            evidence: fixture.originalHeldEvidence,
          });
        }
        expect(attack.proof).toEqual({
          firstHookReached: true,
          completed: true,
        });
        expect(attack.outsideTreeBytes()).toEqual(attack.originalOutsideBytes);
        expect(fixture.pathnameReopens()).toBe(0);
        expect(fixture.openFdCount()).toBe(0);
      }
    }
  }
});

test("profile mutations retain the phase-specific available chains", async () => {
  const fixture = await createProfileMutationChainFixture();
  await fixture.runAllWithHeldEvidence();
  expect(fixture.phaseChains()).toEqual({
    "create-working:before-mkdir": [
      "root", "profiles", "profile", "working-state",
    ],
    "create-working:after-open-bind": [
      "root", "profiles", "profile", "working-state", "generation",
    ],
    "copy:source": [
      "root", "profiles", "profile", "committed-state", "generation",
    ],
    "copy:destination-before-mkdir": [
      "root", "profiles", "profile", "working-state",
    ],
    "copy:destination-after-open-bind": [
      "root", "profiles", "profile", "working-state", "generation",
    ],
    "prepare:source-and-destination": "full-held-chains",
    "finalize:source-and-destination": "full-held-chains",
    "remove:owned-working-or-tombstone": "full-held-chain",
  });
  expect(fixture.revalidatedAtEveryPhaseBoundary()).toBe(true);
  expect(fixture.pathnameReopens()).toBe(0);
});

test("rejects same-inode and streaming source drift", async () => {
  for (const drift of [
    "same-inode-content", "same-inode-mode", "same-inode-size",
    "source-prefix", "source-truncation", "source-extra-bytes",
  ] as const) {
    const fixture = await createHeldCopyFixture();
    const attack = fixture.injectDrift(drift);
    await expect(fixture.copy()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(attack.proof).toEqual({ firstHookReached: true, completed: true });
    expect(fixture.destinationPublished()).toBe(false);
    expect(fixture.openFdCount()).toBe(0);
  }
});

test("records a deleted enumerated child tombstone and fails closed", async () => {
  const fixture = await createHeldCopyFixture();
  fixture.deleteChildAfterEnumeration("Preferences");
  await expect(fixture.copy()).rejects.toMatchObject({
    category: "reconciliation_filesystem_unsafe",
    evidence: {
      kind: "child_missing_after_enumeration",
      path: "Preferences",
    },
  });
  expect(fixture.childTombstoneCount()).toBe(1);
  expect(fixture.copyOrSyncAfterTombstone()).toEqual([]);
});

test("proves the held copy positive control starts and completes", async () => {
  const fixture = await createHeldCopyFixture();
  await fixture.copy();
  expect(fixture.copyProof()).toEqual({
    firstChunkRead: true,
    exactEofObserved: true,
    completed: true,
  });
  expect(fixture.sourceCanonicalTree()).toEqual(
    fixture.destinationCanonicalTree(),
  );
});

test("open/stat and close-then-throw paths close every descriptor", async () => {
  for (const syscall of ["open", "stat", "close-then-throw"] as const) {
    const fixture = await createHeldProfileFixture({ failSyscall: syscall });
    await expect(fixture.exerciseAllHeldApis()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(fixture.closeAttempts()).toEqual(fixture.openedDescriptors());
    expect(fixture.openFdCount()).toBe(0);
  }
});

test("true close rejection retains fail-stop ownership", async () => {
  const fixture = await createHeldProfileFixture({
    failSyscall: "close-reject-unverified",
  });
  await expect(fixture.exerciseAllHeldApis()).rejects.toMatchObject({
    category: "reconciliation_filesystem_unsafe",
  });
  expect(fixture.closeAttempts()).toEqual(fixture.openedDescriptors());
  expect(fixture.failStopOwnership()).toMatchObject({
    state: "close_unverified",
    admission: "closed",
    descriptors: expect.any(Array),
  });
  expect(fixture.assertedZeroOpenFds()).toBe(false);
});

test("profile bounds stop before sync or copy", async () => {
  for (const shape of [
    "entries-25001", "depth-65", "file-64mib-plus-1",
    "tree-256mib-plus-1",
  ] as const) {
    const fixture = await createHeldProfileLimitFixture(shape);
    await expect(fixture.syncOrCopy()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(fixture.syncCalls()).toEqual([]);
    expect(fixture.copyReads()).toEqual([]);
    expect(fixture.openFdCount()).toBe(0);
  }
});

test("Task 3 and Task 4 consume the same held evidence and hash code", async () => {
  const fixture = await createSharedCanonicalizationFixture();
  const task3 = await fixture.canonicalizeAsReconciliation();
  const task4 = await fixture.canonicalizeAsProfileStore();
  expect(task4.evidence).toEqual(task3.evidence);
  expect(task4.canonicalBytes).toEqual(task3.canonicalBytes);
  expect(task4.treeSha256).toBe(task3.treeSha256);
  expect(fixture.legacyTask3ApiSurfaceUnchanged()).toBe(true);
  expect(fixture.hashImplementationIds()).toEqual([
    "reconciliation-private-held-profile-hash",
  ]);
});

test("ProfileStore retains one root only for its ready generation", async () => {
  const fixture = await createProfileStoreGenerationFixture();
  await fixture.openAndCloseSeveralSessions();
  expect(fixture.anchoredRootOpenCalls()).toBe(1);
  expect(fixture.anchoredRootCloseCalls()).toBe(0);
  await fixture.clearReadyDrainAndMintNextUnready();
  expect(fixture.anchoredRootCloseCalls()).toBe(1);
  expect(fixture.currentProfileStore()).toBeUndefined();
  await fixture.reconcileAndInstallNextReadyGeneration();
  expect(fixture.profileStoreInstances()).toBe(2);
  expect(fixture.currentStoreBinding()).toEqual(fixture.nextReadyBinding);
  expect(fixture.currentRootHeld()).toBe(true);
  await fixture.shutdown();
  expect(fixture.openFdCount()).toBe(0);
});

test("captures the root chain before any reconciliation state work", async () => {
  for (const component of fixtureAbsoluteComponents()) {
    const fixture = await createReconciledRootAuthorityFixture();
    const attack = fixture.swapAndRestoreDuringInitialRootCapture(component);
    await expect(
      fixture.reconcileBrowserStateWithAuthority(attack.hooks),
    ).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(attack.proof).toEqual({ firstHookReached: true, completed: true });
    expect(fixture.stateWorkCalls()).toEqual([]);
    expect(fixture.rootCaptureOrder()[0]).toBe("open-slash");
    expect(fixture.parentEntryValidationStarted()).toBe(true);
  }
  const positive = await createReconciledRootAuthorityFixture();
  await positive.reconcileBrowserStateWithAuthority();
  expect(positive.rootCaptureOrder()).toEqual([
    "open-slash", "open-absolute-components-through-held-parents",
    "validate-parent-entries", "capture-initial-held-evidence", "state-work",
    "revalidate-and-seal-outcome-evidence",
  ]);
});

test("internal reconciliation outcome is opaque and public API strips it", async () => {
  const fixture = await createReconciledRootAuthorityFixture();
  const internal = await fixture.reconcileBrowserStateWithAuthority();
  expect(internal).not.toHaveProperty("result");
  expect(internal).not.toHaveProperty("authority");
  expect(fixture.modulePrivateRecordProbe()).toMatchObject({
    canonicalAbsoluteComponents: fixture.expectedCanonicalComponents,
    componentIdentities: fixture.expectedDevInoModeChain,
    binding: fixture.exactProcessControlSnapshotBinding,
  });
  const publicResult = await fixture.reconcileBrowserState();
  expect(publicResult).toEqual(fixture.expectedPublicResult);
  expect(publicResult).not.toHaveProperty("authority");
  await expect(
    fixture.startupAdmission.reconcileWithAuthority(
      fixture.request,
      async () => fixture.castPlainObjectAsInternalOutcome(),
    ),
  ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
});

test("internal reconciliation outcome consumption is exactly once", async () => {
  const fixture = await createReconciledRootAuthorityFixture();
  const outcome = await fixture.reconcileBrowserStateWithAuthority();
  await fixture.consumeOutcomeAndCloseInstall(outcome);
  await expect(
    fixture.consumeOutcomeAndCloseInstall(outcome),
  ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  expect(fixture.outcomeConsumerCalls()).toBe(1);
  expect(fixture.outcomeState(outcome)).toBe("consumed");
});

test("outcome consumer failure closes partial install and stays consumed", async () => {
  const fixture = await createUnreadyRootAuthorityFixture({
    failProfileStoreConstructionAfterAcquire: true,
  });
  let capturedOutcome: InternalReconciliationOutcome | undefined;
  await expect(
    fixture.startupAdmission.reconcileWithAuthority(
      fixture.request,
      async (request, admission) => {
        capturedOutcome = await fixture.captureCurrentAuthority({
          request,
          admission,
        });
        return capturedOutcome;
      },
    ),
  ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  expect(fixture.ready()).toBe(false);
  expect(fixture.partialStoreCloseCalls()).toBe(1);
  expect(fixture.rootCloseCalls()).toBe(1);
  expect(fixture.outcomeState(capturedOutcome!)).toBe("consumed");
});

test("authority install reacquires the exact reconciled root chain", async () => {
  for (const component of fixtureAbsoluteComponents()) {
    const fixture = await createUnreadyRootAuthorityFixture();
    const attack = fixture.transientSwapAndRestoreDuringReacquisition(component);
    fixture.armReacquisitionAttack(attack.hooks);
    const observed = await captureOutcome(
      fixture.startupAdmission.reconcileWithAuthority(
        fixture.request,
        async (request, admission) =>
          fixture.captureCurrentAuthority({ request, admission }),
      ),
    );
    expect(observed).toMatchObject({
      status: "rejected",
      category: "reconciliation_filesystem_unsafe",
    });
    expect(attack.proof).toEqual({ firstHookReached: true, completed: true });
    expect(fixture.rootLeaseCount()).toBe(0);
  }
});

test("startup atomically installs only a genuine current outcome", async () => {
  const fixture = await createUnreadyRootAuthorityFixture();
  const oldBinding = fixture.currentBinding;
  const oldOutcome = await fixture.captureCurrentAuthority();
  await fixture.clearReadyDrainAndMintNextUnready();
  expect(fixture.ready()).toBe(false);
  expect(fixture.currentProfileStore()).toBeUndefined();
  await expect(
    fixture.startupAdmission.reconcileWithAuthority(
      fixture.request,
      async () => oldOutcome,
    ),
  ).rejects.toMatchObject({ category: "reconciliation_required" });
  expect(fixture.rejectedBinding()).toEqual(oldBinding);
  await fixture.startupAdmission.reconcileWithAuthority(
    fixture.request,
    async (request, admission) =>
      fixture.captureNextAuthority({ request, admission }),
  );
  expect(fixture.retainedAuthorityBindings()).toEqual([
    fixture.currentBinding,
  ]);
  expect(fixture.atomicInstallFields()).toEqual([
    "public-result", "authority", "profile-store", "ready",
  ]);
});

test("capabilities reject forgery, foreign roots, and repeated consumption", async () => {
  const fixture = await createHeldCapabilityFixture();
  for (const attempt of [
    fixture.castPlainObjectAsRoot,
    fixture.castPlainObjectAsGeneration,
    fixture.bindGenerationFromForeignRoot,
    fixture.useAfterTransition,
    fixture.doubleTransition,
    fixture.doubleRemove,
    fixture.doubleClose,
    fixture.launchWithForeignWorking,
    fixture.releaseForgedLaunchAttachment,
    fixture.doubleReleaseLaunchAttachment,
    fixture.useAfterReleaseLaunchAttachment,
  ]) {
    await expect(attempt()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
  }
  expect(fixture.serializedStateTransitions()).toEqual([
    "live", "consuming", "consumed",
  ]);
  expect(fixture.allLifecycleStatesSeen()).toEqual([
    "live", "consuming", "consumed", "closed",
  ]);
  expect(fixture.rootCloseDrainedOperationsBeforeDescriptors()).toBe(true);
});

test("create-working holds its parent chain before exclusive child bind", async () => {
  const fixture = await createWorkingPhaseFixture();
  await fixture.create();
  expect(fixture.phaseOrder()).toEqual([
    "hold-root", "hold-profiles", "hold-profile", "hold-working-state",
    "mkdir-generation-nonrecursive-eexist", "open-generation-nofollow",
    "fstat-generation", "revalidate-full-chain", "bind-live",
  ]);
  expect(fixture.heldChainBeforeMkdir()).toEqual([
    "root", "profiles", "profile", "working-state",
  ]);
  expect(fixture.mkdir()).toMatchObject({ recursive: false });
});

test("nested copy creation repeats exclusive held-parent binding", async () => {
  const fixture = await createNestedHeldCopyFixture();
  await fixture.copyCommittedToNewWorking();
  expect(fixture.directoryCreatePhases()).toEqual([
    "hold-parent", "mkdir-nonrecursive-eexist", "open-dir-nofollow",
    "fstat-dir", "revalidate-full-chain",
  ]);
  expect(fixture.fileCreateFlags()).toEqual([
    "O_CREAT|O_EXCL|O_NOFOLLOW",
  ]);
});

test("enforces generation state and exclusive destination rules", async () => {
  for (const attack of [
    "create-in-staging", "create-in-committed", "copy-from-working",
    "copy-from-staging", "copy-to-existing",
    "copy-to-staging", "copy-to-committed", "prepare-not-working",
    "finalize-not-staging", "remove-staging", "remove-committed",
    "mkdir-collision", "mkdir-symlink-race", "file-collision",
    "file-symlink-race", "destination-not-empty",
  ] as const) {
    const fixture = await createCapabilityRuleFixture(attack);
    await expect(fixture.run()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(fixture.nonExclusiveCreateFlags()).toEqual([]);
    expect(fixture.published()).toBe(false);
  }
});

test("copy accepts only committed source and new empty working destination", async () => {
  const fixture = await createCapabilityCopyFixture();
  await fixture.copyCommittedToNewWorking();
  expect(fixture.copyBindingStates()).toEqual({
    source: "committed",
    destination: "working",
    destinationWasAbsentAndEmpty: true,
  });
});

test("remove accepts only owned working and deletion-tombstone bindings", async () => {
  const fixture = await createCapabilityRemovalFixture();
  await fixture.removeOwnedWorking();
  await fixture.removeOwnedDeletionTombstone();
  expect(fixture.removedStates()).toEqual(["working", "tombstone"]);
  expect(fixture.committedRemoveAttempts()).toEqual([]);
});

test("handoff mints unready before later atomic authority installation", async () => {
  for (const operation of ["sync", "copy"] as const) {
    const fixture = await createRootRolloverFixture(operation);
    const active = fixture.pauseMidOperation();
    await fixture.operationPaused();
    const handoff = fixture.beginNewGenerationHandoff();
    expect(fixture.newProfileRootAcquisitionsClosed()).toBe(true);
    expect(fixture.oldRootCloseCalls()).toBe(0);
    fixture.abortOperation();
    await expect(active).rejects.toMatchObject({
      category: "reconciliation_required",
    });
    await handoff;
    expect(fixture.handoffOrder()).toEqual([
      "clear-ready", "close-new-acquisitions", "drain-sessions",
      "drain-root-leases", "close-old-profile-store", "close-old-root",
      "mint-new-generation-unready",
    ]);
    expect(fixture.ready()).toBe(false);
    expect(fixture.installedAuthority()).toBeUndefined();
    await fixture.reconcileWithAuthority(
      async (request, admission) =>
        fixture.reconcileAndCaptureAuthority({ request, admission }),
    );
    expect(fixture.installOrder()).toEqual([
      "reconcile-capture", "reacquire-root", "create-profile-store",
      "atomic-install-result-authority-store-ready",
    ]);
    expect(fixture.ready()).toBe(true);
    expect(fixture.currentRootHeld()).toBe(true);
    await fixture.shutdown();
    expect(fixture.openFdCount()).toBe(0);
  }
});

test("admission aborts every held operation around each await", async () => {
  for (const operation of [
    "canonicalize", "sync", "copy", "create", "prepare", "finalize",
    "remove", "launch",
  ] as const) {
    for (const edge of ["before-await", "after-await"] as const) {
      const fixture = await createAdmissionAbortFixture(operation, edge);
      await expect(fixture.run()).rejects.toMatchObject({
        category: "reconciliation_required",
      });
      expect(fixture.firstEffectAfterAbort()).toBeUndefined();
      expect(fixture.allCloseAttemptsMade()).toBe(true);
    }
  }
});

test("profile mutations survive crash points only through held evidence", async () => {
  for (const phase of [
    "child-create", "child-write", "child-fsync", "postorder-dir-fsync",
    "state-rename", "child-remove", "post-mutation-revalidate",
  ] as const) {
    const fixture = await createHeldMutationCrashFixture(phase);
    await expect(fixture.run()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(fixture.outsideTreeTouched()).toBe(false);
    expect(fixture.profileLifecycleCalls()).toEqual([]);
    await fixture.recoverWithHeldEvidence();
    expect(fixture.recoveredCanonicalOrDiscarded()).toBe(true);
  }
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

test("real Chromium launches only through the retained generation fd", async () => {
  for (const swapAt of ["before-launch", "during-launch"] as const) {
    const fixture = await createRealProcfdLaunchFixture({ swapAt });
    const outcome = await captureOutcome(fixture.launchBundledChromium());
    expect(fixture.publicWorkingCopy).not.toHaveProperty("path");
    expect(fixture.launchApiCalls()).toEqual([
      "launchPersistentChromiumForWorking",
    ]);
    expect(fixture.launchArgument()).toBe(
      `/proc/${fixture.browserServicePid}/fd/${fixture.generationFd}`,
    );
    expect(fixture.procfdIdentityImmediatelyBeforeLaunch()).toEqual(
      fixture.boundGenerationIdentity,
    );
    expect(fixture.rootLeaseHeldThroughSession()).toBe(true);
    expect(fixture.publicProcfdValues()).toEqual([]);
    expect(fixture.fdExposed()).toBe(false);
    expect(fixture.canonicalSwapProof()).toEqual({
      root: true, state: true, working: true, restored: true,
    });
    expect(fixture.usedOriginalOwnedInodeOrFailedBeforeLaunch(outcome))
      .toBe(true);
    expect(fixture.attackerTreeWrites()).toEqual([]);
    if (outcome.status === "succeeded") {
      await fixture.releaseChromiumSessionAttachment();
      expect(fixture.rootLeaseHeldThroughSession()).toBe(false);
      expect(fixture.launchAttachmentReleased()).toBe(true);
      await expect(
        fixture.releaseChromiumSessionAttachment(),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      await expect(
        fixture.useReleasedChromiumSessionAttachment(),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    }
  }
});

test("launch or Registry attachment failure cleans the opaque attachment", async () => {
  for (const phase of [
    "internal-launcher-after-context", "registry-attachment",
  ] as const) {
    const fixture = await createLaunchAttachmentFailureFixture(phase);
    await expect(fixture.run()).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(fixture.releaseCalls()).toBe(1);
    expect(fixture.contextAndBrowserCloseAttemptsMade()).toBe(true);
    expect(fixture.procfdValuesOutsideLauncher()).toEqual([]);
    expect(fixture.verifiedCloseReleasedLeaseOrRetainedFailStop()).toBe(true);
  }
});

test("real Chromium restores through a closed proxy ingress gate", async () => {
  const restored = await restoreRealCheckpoint({
    cookies: true, localStorage: true, indexedDB: true,
  });
  expect(restored.preVerificationIngressViolations).toBe(0);
  expect(restored.preVerificationDnsResolutions).toBe(0);
  expect(restored.preVerificationPolicyDecisions).toBe(0);
  expect(restored.preVerificationDials).toBe(0);
  expect(restored.documentValues).toEqual(EXPECTED_STORAGE_VALUES);
  expect(restored.requestFileCanonicalBytes).toEqual(
    restored.checkpointFileCanonicalBytes,
  );
  expect(restored.exportedSemanticBytes).toEqual(
    restored.requestSemanticBytes,
  );
  expect(restored.checkpointFileChecksum).toBe(
    sha256(restored.checkpointFileCanonicalBytes),
  );
});

test("uses exact restore order without a launch storageState option", async () => {
  const restored = await restoreRealCheckpoint({ captureCallOrder: true });
  expect(restored.launchOptions).not.toHaveProperty("storageState");
  expect(restored.callOrder).toEqual([
    "validate", "registry-provisional", "working-copy",
    "proxy-gate-closed", "launch-attempt-owned",
    "verify-procfd-generation", "launch",
    "set-storage-state", "export-unknown", "parse", "compare",
    "assert-zero-ingress-violations", "open-gate", "acquire-page",
    "navigate", "fingerprint", "publish-session",
  ]);
});

test("opens a non-replay gate before initial page work", async () => {
  const created = await createRealSessionWithoutReplay({
    captureCallOrder: true,
    observeProxyIngress: true,
  });
  expect(created.callOrder).toEqual([
    "validate", "registry-provisional", "working-copy",
    "proxy-gate-closed", "launch-attempt-owned",
    "verify-procfd-generation", "launch",
    "assert-zero-ingress-violations",
    "open-gate", "acquire-page", "navigate-initial-url", "fingerprint",
    "publish-session",
  ]);
  expect(created.preOpenIngressViolations).toBe(0);
  expect(created.preOpenDnsResolutions).toBe(0);
  expect(created.preOpenPolicyDecisions).toBe(0);
  expect(created.preOpenDials).toBe(0);
  expect(created.postOpenInitialUrlOrder).toEqual([
    "ingress-linearize", "dns", "policy", "dial",
  ]);
});

test("permits desktop launch-owned pages but no service page work", async () => {
  const restored = await restoreRealCheckpoint({ observePageLifecycle: true });
  expect(restored.launchOwnedPageLifecycle).toEqual([
    "about:blank-initialized",
  ]);
  expect(restored.servicePageOperationsBeforeVerification).toEqual([]);
});

test("permits mobile launch-owned replacement but no service page work", async () => {
  const restored = await restoreRealCheckpoint({
    device: "validated-mobile-device",
    observePageLifecycle: true,
  });
  expect(restored.launchOwnedPageLifecycle).toEqual([
    "about:blank-initialized",
    "mobile-default-page-created",
    "about:blank-closed",
  ]);
  expect(restored.servicePageOperationsBeforeVerification).toEqual([]);
});

test("never uses suppressed context events as the ingress oracle", async () => {
  const restored = await restoreRealCheckpoint({ captureEgressOracle: true });
  expect(restored.egressOracle).toBe("proxy-restore-gate");
  expect(restored.contextEventOracleSubscriptions).toEqual([]);
});

test("blocks each closed-gate ingress before DNS, policy, or dial", async () => {
  for (const [entryPoint, category] of [
    ["http-handler", "http"],
    ["https-connect", "connect"],
    ["wss-connect", "connect"],
    ["ws-upgrade", "upgrade"],
  ] as const) {
    const attempt = await attemptClosedRestoreIngress(entryPoint);
    expect(attempt).toMatchObject({
      gateState: "restore_closed",
      recordedCategory: category,
      ingressAttempts: 1,
      ingressViolations: 1,
      dnsResolutions: 0,
      policyDecisions: 0,
      dials: 0,
    });
    expect(() => attempt.gate.open()).toThrowError(
      "restore_ingress_violation",
    );
  }
});

test("enforces exact gate transitions and idempotent close", () => {
  const opened = createRestoreGate();
  opened.open();
  expect(opened.state).toBe("open");
  expect(() => opened.open()).toThrowError("restore_gate_invalid_state");
  expect(opened.state).toBe("open");
  opened.close();
  opened.close();
  expect(opened.state).toBe("closed");

  const closed = createRestoreGate();
  closed.close();
  closed.close();
  expect(() => closed.open()).toThrowError("restore_gate_invalid_state");
  expect(closed.state).toBe("closed");
});

test("isolates gate counters by session", async () => {
  const first = createRestoreGate();
  const second = createRestoreGate();
  await attemptClosedRestoreIngress("http-handler", first);
  expect(first.snapshot()).toEqual({
    state: "restore_closed",
    counters: {
      ingressAttempts: 1, ingressViolations: 1, dnsResolutions: 0,
      policyDecisions: 0, dials: 0,
    },
  });
  expect(second.snapshot()).toEqual({
    state: "restore_closed",
    counters: {
      ingressAttempts: 0, ingressViolations: 0, dnsResolutions: 0,
      policyDecisions: 0, dials: 0,
    },
  });
  second.open();
  expect(second.state).toBe("open");
  expect(first.snapshot()).toEqual({
    state: "restore_closed",
    counters: {
      ingressAttempts: 1, ingressViolations: 1, dnsResolutions: 0,
      policyDecisions: 0, dials: 0,
    },
  });
});

test("fails closed before downstream on any counter overflow", async () => {
  for (const counter of [
    "ingressAttempts", "ingressViolations", "dnsResolutions",
    "policyDecisions", "dials",
  ] as const) {
    const gate = gateForCounterIncrement(counter, {
      [counter]: Number.MAX_SAFE_INTEGER,
    });
    const beforeCounters = gate.completeCounterSnapshot();
    const attempt = await attemptThatWouldIncrement(counter, gate);
    expect(attempt.result).toBe("counter_overflow");
    expect(gate.state).toBe("closed");
    expect(gate.counters[counter]).toBe(Number.MAX_SAFE_INTEGER);
    expect(gate.completeCounterSnapshot()).toEqual(beforeCounters);
    expect(attempt.downstreamAfterOverflow).toEqual([]);
  }
});

test("never queues or permits open after closed-linearized ingress", async () => {
  const attempt = await pauseClosedGateIngressAtLinearization();
  expect(() => attempt.gate.open()).toThrowError(
    "restore_ingress_violation",
  );
  await attempt.release();
  expect(attempt.result).toBe("rejected_while_restore_closed");
  expect(attempt.gate.state).toBe("restore_closed");
  expect(attempt.queuedOrReplayed).toBe(false);
  expect(attempt.dnsResolutions).toBe(0);
  expect(attempt.dials).toBe(0);
});

test("opens the gate once and observes the final URL positive control", async () => {
  const restored = await restoreRealCheckpoint({ observeProxyIngress: true });
  expect(restored.gateTransitions).toEqual(["restore_closed", "open"]);
  expect(restored.preVerificationIngressViolations).toBe(0);
  expect(restored.postOpenIngressUrls).toContain(restored.finalUrl);
  expect(restored.postOpenIngressOrder).toEqual([
    "ingress-linearize", "dns", "policy", "dial",
  ]);
});

test("normalizes empty origins and absent IndexedDB as empty", async () => {
  const restored = await restoreRealCheckpoint({
    includeEmptyOrigin: true,
    omitEmptyIndexedDbInRequest: true,
  });
  expect(restored.exportedSemanticBytes).toEqual(
    restored.requestSemanticBytes,
  );
});

test("normalizes keyed and inline-key IndexedDB record order", async () => {
  const restored = await restoreRealCheckpoint({
    reverseKeyedRecords: true,
    reverseInlineKeyRecords: true,
  });
  expect(restored.exportedSemanticBytes).toEqual(
    restored.requestSemanticBytes,
  );
});

test("uses tagged bytewise total order and rejects duplicate identities", async () => {
  const tagged = tagCollisionFixture();
  expect(await semanticNormalize(tagged.forward)).toEqual(
    await semanticNormalize(tagged.reversed),
  );
  for (const fixture of [
    samePrimaryKeyDifferentPayload(),
    duplicateCookieIdentity(),
    duplicateNestedIdentity(),
  ]) {
    await expect(semanticNormalize(fixture)).rejects.toMatchObject({
      category: "replay_unavailable",
    });
  }
  expect(await semanticNormalize(nonAsciiReversalFixture())).toEqual(
    await semanticNormalize(forwardNonAsciiFixture()),
  );
});

test("rejects a malformed unknown export after launch and cleans all resources", async () => {
  const restored = await createRestoreHarness({
    exportedStorageState: malformedUnknownExport(),
  });
  await expect(restored.run()).rejects.toMatchObject({
    category: "replay_unavailable",
  });
  expect(restored.launchCount).toBe(1);
  expect(await restored.registryEntries()).toEqual([]);
  expect(restored.hasLiveContext()).toBe(false);
  expect(restored.proxyListenerOpen()).toBe(false);
  expect(restored.liveProxySockets()).toBe(0);
  expect(restored.profileDiscardAttempts).toBe(1);
  expect(await restored.profileStore.listWorking()).toEqual([]);
  expect(restored.profileLifecycleCalls).toEqual([]);
});

test("owns or self-cleans working and proxy acquisition failures", async () => {
  for (const phase of [
    "working-copy", "proxy-bind", "proxy-start",
  ] as const) {
    const restored = await createRestoreHarness({ failAt: phase });
    await expect(restored.run()).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(restored.acquisitionTrace[0]).toBe("registry-provisional");
    expect(restored.workingOrProxyConstructorSelfCleanVerified).toBe(true);
    expect(await restored.registryEntries()).toEqual([]);
    expect(restored.hasLiveContext()).toBe(false);
    expect(restored.proxyListenerOpen()).toBe(false);
    expect(restored.liveProxySockets()).toBe(0);
    expect(restored.profileDiscardAttempts).toBe(
      phase === "working-copy" ? 0 : 1,
    );
    expect(await restored.profileStore.listWorking()).toEqual([]);
    expect(restored.profileLifecycleCalls).toEqual([]);
    expect(restored.launchCount).toBe(0);
  }
});

test("discards only a trusted pre-spawn launch rejection", async () => {
  const restored = await createRestoreHarness({
    failAt: "launch-reject",
    trustedLaunchFailureProof: "preSpawn",
  });
  await expect(restored.run()).rejects.toMatchObject({
    category: "replay_unavailable",
  });
  expect(restored.acquisitionTrace).toContain("launch-attempt-owned");
  expect(restored.acquisitionTrace).toContain("verify-procfd-generation");
  expect(restored.launchCount).toBe(1);
  expect(restored.trustedPreSpawnProofAccepted).toBe(true);
  expect(restored.browserProcessOrResourceCreated).toBe(false);
  expect(restored.hasOwnedContext()).toBe(false);
  expect(restored.proxyListenerOpen()).toBe(false);
  expect(restored.liveProxySockets()).toBe(0);
  expect(restored.profileDiscardAttempts).toBe(1);
  expect(await restored.profileStore.listWorking()).toEqual([]);
  expect(await restored.registryEntries()).toEqual([]);
  expect(restored.globalAdmissionOpen()).toBe(true);
  expect(restored.profileLifecycleCalls).toEqual([]);
});

test("retains unverified timeout or post-spawn launch rejection", async () => {
  for (const phase of [
    "launch-timeout", "launch-reject-post-spawn",
  ] as const) {
    const restored = await createRestoreHarness({ failAt: phase });
    const error = await captureRejection(restored.run());
    expect(error).toMatchObject({ category: "replay_unavailable" });
    expect(restored.launchCount).toBe(1);
    expect(restored.acquisitionTrace).toContain("launch-attempt-owned");
    expect(restored.acquisitionTrace).toContain("verify-procfd-generation");
    expect(restored.errorReturnedAfterOwnershipRecorded).toBe(true);
    expect(restored.usedPrivateProcessApi).toBe(false);
    expect(restored.hasOwnedContext()).toBe(false);
    expect(restored.proxyListenerOpen()).toBe(false);
    expect(restored.liveProxySockets()).toBe(0);
    expect(restored.profileDiscardAttempts).toBe(0);
    expect((await restored.profileStore.listWorking()).length).toBe(1);
    expect(await restored.registryEntries()).toMatchObject([{
      state: "cleanup_failed",
      admission: "closed",
      cleanupDetail: "launch_cleanup_unverified",
      launchAttempt: {
        state: "cleanup_unverified",
        publicProcessHandle: null,
      },
    }]);
    expect(restored.globalAdmissionOpen()).toBe(false);
    expect(restored.readiness()).toBe(false);
    expect(restored.profileLifecycleCalls).toEqual([]);
    const workingGeneration = restored.workingGenerationId;

    await restored.registry.sweepCleanupFailed();
    expect(await restored.registryEntries()).toMatchObject([{
      cleanupDetail: "launch_cleanup_unverified",
      launchAttempt: { state: "cleanup_unverified" },
    }]);
    expect((await restored.profileStore.listWorking()).length).toBe(1);

    const restarted = await restored.restartServiceAndReconcile();
    expect(restarted.oldChromiumTerminationGuaranteed).toBe(true);
    expect(restarted.startupOrder).toEqual([
      "guarantee-old-process-termination", "reconcile-retain-young-working",
      "ready",
    ]);
    expect(await restarted.registryEntries()).toEqual([]);
    expect(await restarted.profileStore.listWorking()).toEqual([
      workingGeneration,
    ]);
    expect(await restarted.publishedProfiles()).toEqual([]);
    expect(restarted.reconciliationCompletedBeforeReady).toBe(true);
    expect(restarted.createdLaunchCleanupMarker).toBe(false);
    expect(restarted.globalAdmissionOpen()).toBe(true);
    expect(restarted.readiness()).toBe(true);
    expect(restarted.profileLifecycleCalls).toEqual([]);

    restarted.clock.advance(600_001);
    const later = await restarted.restartServiceAndReconcile();
    expect(later.reconciliationRemoval).toMatchObject({
      generationId: workingGeneration,
      usedExistingTask3ManifestProtocol: true,
      crashSafeRenameFsyncDelete: true,
    });
    expect(await later.profileStore.listWorking()).toEqual([]);
    expect(await later.publishedProfiles()).toEqual([]);
    expect(later.profileLifecycleCalls).toEqual([]);
    expect(later.createdLaunchCleanupMarker).toBe(false);
    expect(later.readiness()).toBe(true);
  }
});

test("cleans every later failure without publication", async () => {
  for (const phase of [
    "set-storage-state", "export", "parse", "compare", "gate-open",
    "navigation", "fingerprint", "operation-timeout", "chromium-crash",
  ] as const) {
    const restored = await createRestoreHarness({ failAt: phase });
    await expect(restored.run()).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(restored.launchCount).toBe(1);
    expect(await restored.registryEntries()).toEqual([]);
    expect(restored.hasLiveContext()).toBe(false);
    expect(restored.proxyListenerOpen()).toBe(false);
    expect(restored.liveProxySockets()).toBe(0);
    expect(restored.profileDiscardAttempts).toBe(1);
    expect(await restored.profileStore.listWorking()).toEqual([]);
    expect(restored.profileLifecycleCalls).toEqual([]);
  }
});

test("uses public browser close after graceful context close fails", async () => {
  for (const gracefulFailure of ["reject", "timeout"] as const) {
    const restored = await createRestoreHarness({
      failAt: "compare",
      contextCloseFailure: gracefulFailure,
      browserCloseResult: "verified-disconnected",
    });
    await expect(restored.run()).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(restored.contextCloseCalls).toBe(1);
    expect(restored.originalContextClosePromisePreserved).toBe(true);
    expect(restored.originalContextCloseSettlementObserved).toBe(true);
    expect(restored.browserCloseSource).toBe("context.browser()");
    expect(restored.browserCloseCalls).toBe(1);
    expect(restored.cleanupAttempts).toEqual([
      "context-close", "browser-close", "gate-close",
      "proxy-listener-close", "proxy-socket-drain", "profile-discard",
    ]);
    expect(restored.browserDisconnected()).toBe(true);
    expect(await restored.registryEntries()).toEqual([]);
    expect(restored.hasLiveContext()).toBe(false);
    expect(restored.proxyListenerOpen()).toBe(false);
    expect(restored.liveProxySockets()).toBe(0);
    expect(restored.profileDiscardAttempts).toBe(1);
    expect(await restored.profileStore.listWorking()).toEqual([]);
    expect(restored.profileLifecycleCalls).toEqual([]);
  }
});

test("retains both failed public close attempts without recalling context close", async () => {
  const restored = await createRestoreHarness({
    failAt: "compare",
    contextCloseFailure: "timeout",
    browserCloseResult: "reject",
  });
  await expect(restored.run()).rejects.toMatchObject({
    cleanupCodes: ["chromium_close_failed"],
  });
  expect(restored.contextCloseCalls).toBe(1);
  expect(restored.browserCloseCalls).toBe(1);
  expect(restored.cleanupAttempts).toEqual([
    "context-close", "browser-close", "gate-close",
    "proxy-listener-close", "proxy-socket-drain",
    "profile-discard-if-context-closed",
  ]);
  expect(await restored.registryEntries()).toMatchObject([{
    state: "cleanup_failed",
    admission: "closed",
    contextCloseState: "closing",
    originalContextClosePromiseRetained: true,
    browserCloseState: "rejected",
  }]);
  expect(restored.hasLiveContext()).toBe(true);
  expect(restored.proxyListenerOpen()).toBe(false);
  expect(restored.liveProxySockets()).toBe(0);
  expect(restored.profileDiscardAttempts).toBe(0);
  expect((await restored.profileStore.listWorking()).length).toBe(1);
  expect(restored.profileLifecycleCalls).toEqual([]);

  await restored.registry.sweepCleanupFailed();
  expect(restored.contextCloseCalls).toBe(1);
  expect(restored.originalContextClosePromiseObservationActive).toBe(true);
  expect(restored.browserPublicStateAllowsRetry()).toBe(true);
  expect(restored.browserCloseCalls).toBe(2);
  expect(await restored.registryEntries()).toMatchObject([{
    state: "cleanup_failed",
    admission: "closed",
  }]);

  restored.allowBrowserCloseToSucceed();
  await restored.registry.sweepCleanupFailed();
  expect(restored.contextCloseCalls).toBe(1);
  expect(restored.browserCloseCalls).toBe(3);
  expect(await restored.registryEntries()).toEqual([]);
  expect(restored.hasLiveContext()).toBe(false);
  expect(await restored.profileStore.listWorking()).toEqual([]);
});

test("retains cleanup when persistent context has no public browser handle", async () => {
  const restored = await createRestoreHarness({
    failAt: "compare",
    contextCloseFailure: "reject",
    contextBrowserResult: null,
  });
  await expect(restored.run()).rejects.toMatchObject({
    cleanupCodes: ["chromium_close_failed"],
  });
  expect(restored.contextCloseCalls).toBe(1);
  expect(restored.browserCloseCalls).toBe(0);
  expect(await restored.registryEntries()).toMatchObject([{
    state: "cleanup_failed",
    admission: "closed",
    contextCloseState: "rejected",
    browserCloseState: "unavailable",
  }]);
  expect(restored.hasLiveContext()).toBe(true);
  expect(restored.proxyListenerOpen()).toBe(false);
  expect(restored.liveProxySockets()).toBe(0);
  expect(restored.profileDiscardAttempts).toBe(0);
  expect((await restored.profileStore.listWorking()).length).toBe(1);
  expect(restored.profileLifecycleCalls).toEqual([]);
});

test("retains truthful cleanup_failed ownership until sweeper succeeds", async () => {
  for (const failure of [
    {
      step: "proxy-listener-close", code: "proxy_listener_close_failed",
      liveContext: false, listenerOpen: true, liveSockets: 0,
      profileDiscardAttempts: 1, workingCopies: 0,
    },
    {
      step: "proxy-socket-drain", code: "proxy_socket_drain_failed",
      liveContext: false, listenerOpen: false, liveSockets: 1,
      profileDiscardAttempts: 1, workingCopies: 0,
    },
    {
      step: "profile-discard", code: "profile_discard_failed",
      liveContext: false, listenerOpen: false, liveSockets: 0,
      profileDiscardAttempts: 1, workingCopies: 1,
    },
  ] as const) {
    const restored = await createRestoreHarness({
      failAt: "compare",
      cleanupFailures: [failure.step],
    });
    await expect(restored.run()).rejects.toMatchObject({
      cleanupCodes: [failure.code],
    });
    expect(restored.cleanupAttempts).toEqual([
      "context-close", "gate-close", "proxy-listener-close",
      "proxy-socket-drain", "profile-discard-if-context-closed",
    ]);
    expect(await restored.registryEntries()).toMatchObject([{
      state: "cleanup_failed",
      admission: "closed",
    }]);
    expect(restored.hasLiveContext()).toBe(failure.liveContext);
    expect(restored.proxyListenerOpen()).toBe(failure.listenerOpen);
    expect(restored.liveProxySockets()).toBe(failure.liveSockets);
    expect(restored.profileDiscardAttempts)
      .toBe(failure.profileDiscardAttempts);
    expect((await restored.profileStore.listWorking()).length)
      .toBe(failure.workingCopies);
    expect(restored.profileLifecycleCalls).toEqual([]);

    restored.clearCleanupFailure(failure.step);
    await restored.registry.sweepCleanupFailed();
    expect(await restored.registryEntries()).toEqual([]);
    expect(restored.hasLiveContext()).toBe(false);
    expect(restored.proxyListenerOpen()).toBe(false);
    expect(restored.liveProxySockets()).toBe(0);
    expect(await restored.profileStore.listWorking()).toEqual([]);
  }
});

test("publishes a writer only after verified normal resource shutdown", async () => {
  const restored = await createWriterSessionHarness();
  await restored.close();
  expect(restored.closeOrder).toEqual([
    "context-close-verified", "gate-close", "listener-close-verified",
    "sockets-drained", "profile-prepare", "profile-finalize",
    "publish-generation",
  ]);

  for (const phase of [
    "context-close", "proxy-listener-close", "proxy-socket-drain",
  ] as const) {
    const failed = await createWriterSessionHarness({
      cleanupFailure: phase,
      browserCloseResult: phase === "context-close" ? "reject" : undefined,
    });
    await expect(failed.close()).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(failed.profileLifecycleCalls).toEqual([]);
    expect(await failed.registryEntries()).toMatchObject([{
      state: "cleanup_failed",
      admission: "closed",
    }]);
  }
});

test("accepts foundation-canonical storage with unsorted semantic arrays", async () => {
  const restored = await restoreRealCheckpoint({
    preserveUnsortedCookieOriginAndIndexedDbArrays: true,
  });
  expect(restored.requestFileCanonicalBytes).toEqual(
    restored.checkpointFileCanonicalBytes,
  );
  expect(restored.exportedSemanticBytes).toEqual(
    restored.requestSemanticBytes,
  );
  expect(restored.exportedSemanticBytes)
    .not.toEqual(restored.checkpointFileCanonicalBytes);
});

test("checkpoint file is canonical storage bytes, not an envelope", async () => {
  for (const fixture of [
    fullCheckpointEnvelopeFile(),
    storageFileWithWhitespace(),
    wrongByteSizeMetadata(),
    wrongChecksumMetadata(),
    requestStorageDifferentFromFile(),
    pathWithInsertedNamespaceBeforeReplay(),
    pathWithDoubledReplaySegment(),
  ]) {
    const harness = await createFreshReplayHarness(fixture);
    await expect(harness.restore()).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(harness.launchCount).toBe(0);
    expect(harness.launchPersistentContext).not.toHaveBeenCalled();
    expect(harness.profileStore.createWorkingCopy).not.toHaveBeenCalled();
    expect(harness.createEgressProxy).not.toHaveBeenCalled();
    expect(await harness.registryEntries()).toEqual([]);
    expect(await harness.profileStore.listWorking()).toEqual([]);
    expect(await harness.publishedProfiles()).toEqual([]);
    await harness.dispose();
  }
});

test("restore crash discards work and never publishes a profile", async () => {
  await expect(restoreRealCheckpoint({ crashAfterSetStorageState: true }))
    .rejects.toMatchObject({ category: "replay_unavailable" });
  expect(await profileStore.listStaging()).toEqual([]);
  expect(await profileStore.listCommitted()).toEqual([]);
  expect(await profileStore.listWorking()).toEqual([]);
});
```

Place primitive Budget/evidence/swap/drift/limit/FD tests in
`reconciliation.test.ts`; place authority installation, ready-binding,
generation-rollover, and drain-order tests in `startup-state.test.ts`; place
ProfileStore generation-lifetime, mutation-chain, empty
writer, prepare/finalize, and consumer-equivalence tests in
`profile-store.test.ts`; place the procfd launch and real Chromium swap cases in
the replay integration test. Existing Task 3 reconciliation cases remain
unchanged in public behavior; `reconciliation.test.ts` gains additive initial
root-capture, held-adapter, and close-semantics coverage.

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/profile-store.test.ts src/session-registry.test.ts src/replay-restore.integration.test.ts src/egress-proxy.test.ts src/reconciliation.test.ts src/startup-state.test.ts
```

Expected: FAIL because held-profile API, profile store, and registry do not
exist.

- [ ] **Step 3: Implement root-confined two-phase profile publication**

Extend `reconciliation.ts` with a narrow opaque held-profile API while
preserving every existing Task 3 export and call path:

```ts
declare const anchoredProfileRootBrand: unique symbol;
declare const boundProfileGenerationBrand: unique symbol;
declare const internalReconciliationOutcomeBrand: unique symbol;
declare const installedReconciledAuthorityBrand: unique symbol;
declare const chromiumSessionAttachmentBrand: unique symbol;

type ReconciledRootEvidence = Readonly<{
  canonicalAbsoluteComponents: readonly string[];
  componentIdentities: readonly Readonly<{
    dev: string;
    ino: string;
    mode: number;
  }>[];
  binding: Readonly<{
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: string;
  }>;
}>;

export type AnchoredProfileRoot = Readonly<{
  [anchoredProfileRootBrand]: true;
}>;

// Internal export for startup-state.ts only; omitted from the public barrel.
export type InternalReconciliationOutcome = Readonly<{
  [internalReconciliationOutcomeBrand]: true;
}>;

export type InstalledReconciledAuthority = Readonly<{
  [installedReconciledAuthorityBrand]: true;
}>;

export type ProfileGenerationLocator = Readonly<{
  profileId: string;
  state: "working" | "staging" | "committed";
  generationId: string;
  openMode: "existing" | "create_exclusive";
}>;

export type BoundProfileGeneration = Readonly<{
  [boundProfileGenerationBrand]: true;
  transitionTo(
    state: "staging" | "committed",
  ): Promise<BoundProfileGeneration>;
  remove(): Promise<void>;
  close(): Promise<void>;
}>;

export type ReadyProfileRootBinding = Readonly<{
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
}>;

export type ChromiumSessionAttachment = Readonly<{
  [chromiumSessionAttachmentBrand]: true;
  context: BrowserContext;
}>;

export type InternalReconciliationInstall = Readonly<{
  publicResult: ReconciliationResultV1;
  authority: InstalledReconciledAuthority;
  root: AnchoredProfileRoot;
}>;

export async function closeAnchoredProfileRoot(
  root: AnchoredProfileRoot,
): Promise<void>;
export async function bindProfileGeneration(
  root: AnchoredProfileRoot,
  locator: ProfileGenerationLocator,
): Promise<BoundProfileGeneration>;
export async function canonicalizeHeldProfileTree(
  generation: BoundProfileGeneration,
): Promise<CanonicalProfileTreeEvidence>;
export async function syncAndCanonicalizeHeldProfileTree(
  generation: BoundProfileGeneration,
): Promise<CanonicalProfileTreeEvidence>;
export async function copyHeldProfileTree(
  source: BoundProfileGeneration,
  destination: BoundProfileGeneration,
): Promise<CanonicalProfileTreeEvidence>;
export async function consumeInternalReconciliationOutcome<T>(
  outcome: InternalReconciliationOutcome,
  binding: ReadyProfileRootBinding,
  consume: (install: InternalReconciliationInstall) => Promise<T>,
): Promise<T>;
export async function launchPersistentChromiumForWorking(
  working: BoundProfileGeneration,
  binding: ReadyProfileRootBinding,
  options: ValidatedPersistentChromiumOptions,
): Promise<ChromiumSessionAttachment>;
export async function releaseChromiumSessionAttachment(
  attachment: ChromiumSessionAttachment,
): Promise<void>;

// Internal export for startup-state.ts only; omitted from the public barrel.
export async function reconcileBrowserStateWithAuthority(
  canonicalRoot: string,
  request: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
): Promise<InternalReconciliationOutcome>;
```

The unique brands are compile-time hints only. Module-private WeakMaps are the
runtime authority for root, generation, launch attachment, and internal outcome
objects; casts or foreign objects fail. The internal outcome has no forgeable
`result` or `authority` fields. Its WeakMap record holds the public result and
`ReconciledRootEvidence`; neither is exported through the public barrel.
Preserve the existing public `ReconciliationResultV1` and
`reconcileBrowserState()` API exactly: it delegates to the internal form,
returns only a cloned public result, and disposes its uninstalled internal
outcome.

`consumeInternalReconciliationOutcome()` is the only outcome accessor. It
runtime-authenticates the fieldless token and exact binding, permits one call,
and synchronously moves its WeakMap record `fresh → consuming → consumed`
before invoking the typed consumer. It reacquires the held root and creates an
opaque `InstalledReconciledAuthority`; the consumer receives only a cloned
public result plus runtime-authenticated authority/root capabilities, never raw
evidence or FDs. A forged, foreign, stale, concurrently reused, or already
consumed outcome fails before callback. There is no fallible work after a
successful consumer returns. Consumer failure closes any constructed store via
the controller, then this function closes/revokes root and authority; the
outcome remains consumed and cannot be retried.

Before any snapshot, namespace enumeration, cleanup-plan read, or other state
work, internal reconciliation opens `/`, then every canonical absolute root
component through `/proc/self/fd/<held-parent>/<component>` with
`O_DIRECTORY | O_NOFOLLOW`. It retains `/` through the final root for the
entire run, validates each held parent entry and child identity around every
await, captures initial canonical components/dev/ino/mode from those handles,
then derives all state work from that chain. Immediately before closing the
same handles, it revalidates them and seals the initial evidence plus the exact
process/control/snapshot binding into the outcome's WeakMap record. A
capture-time component swap fails before any state work; later reacquisition
must match every captured component.

Task 4 adds internal `InternalStartupAdmission.reconcileWithAuthority()` while
keeping public `StartupAdmission.reconcile()` unchanged, using the closed
interface declared in Task 3. The internal method owns the existing execution
callback/admission boundary. It invokes `execute` itself, then immediately passes the completed outcome and
current unready process/control/snapshot binding to
`consumeInternalReconciliationOutcome()`. Its fixed internal consumer builds
the generation-scoped ProfileStore and atomically caches cloned public result,
installed authority, held root/store, and ready state. No route receives the
completed outcome, extracts authority, or calls `requireReady()` between these
steps. Authentication, execution, reacquisition, or store-construction failure
closes partial resources, installs no ready state, and leaves the generation
unready.

Root reacquisition checks the exact binding before and after every await, opens
`/` and each canonical component through the preceding procfd with
`O_DIRECTORY | O_NOFOLLOW`, retains the entire ancestor chain, and compares
every dev/ino/mode with captured evidence. This internal handoff is the sole
`AnchoredProfileRoot` constructor; there is no public root-open function.

Control-generation handoff first clears ready and closes new acquisitions,
drains sessions and outstanding root leases, closes the old ProfileStore and
old root chain, then mints the next generation in an unready state. A later
reconciliation captures its outcome; `reconcileWithAuthority()` reacquires the
root, creates the store, and performs the single atomic install/ready flip.
Authority is never installed during mint. StartupAdmission remains reusable
across generations. Drain/close/reconciliation/install failure leaves the new
generation unready and installs no partial authority.

`bindProfileGeneration()` validates canonical lowercase UUID/state tokens and
opens/holds the exact root→`profiles`→profile→state→generation directory chain
through procfd children. Its opaque capability also supplies only high-level
create-exclusive bind, state-transition rename, and generation-remove
operations needed by ProfileStore; evidence child cleanup remains internal to
copy/walk code, and no raw pathname or FD escapes. Every
mutation holds and revalidates the complete root-through-state chain before and
after mutation, including destination state for transitions. Permit only
working→staging and staging→committed; any other transition fails before
mutation. Transition/remove consumes the old binding, and `close()` releases an
unused binding. Create fsyncs the held parent; transition fsyncs held source and
destination parents; recursive child removal is postorder and fsyncs each held
parent.

Runtime authority comes from module-private WeakMap records, not TypeScript
brands. Root and generation records serialize leases and use only
`live | consuming | consumed | closed`; casts, foreign-root objects,
use-after-consume, double transition/remove, and double close fail before
filesystem effect. Root close first rejects new operations, waits for every
serialized lease and child binding to drain, then attempts every descriptor
close. No generation operation may outlive its root lease.

`create_exclusive` is valid only for an absent working generation. It first
holds only the available parent chain
root→`profiles`→profile→`working`, calls nonrecursive procfd-relative mkdir, and
fails on `EEXIST`. Only after mkdir does it open the generation child with
`O_DIRECTORY | O_NOFOLLOW`, fstat it, and revalidate the full now-existing chain
before returning a live binding. No test or implementation may claim a
generation handle exists before that mkdir.

Copy accepts only a committed source and an absent, newly created, empty
working destination; working or staging source capabilities fail before the
first destination mutation. Every nested destination directory repeats the
same held-parent, nonrecursive mkdir/`EEXIST`, no-follow open, fstat, and
full-chain revalidation sequence. All service-created destination files use
`O_CREAT | O_EXCL | O_NOFOLLOW`; a non-empty destination, collision, symlink,
or replacement race fails unsafe without overwrite or publication. Prepare is
only working→staging, finalize only staging→committed. General removal accepts
only a module-owned working or deletion-tombstone binding and never a committed
generation; reconciliation retains its separately authorized cleanup path.

These helpers adapt the existing private reconciliation `Budget`, iterative
walker, canonical encoder, hash, and evidence implementation. Preserve
`canonicalizeProfileTree(canonicalRoot, path)` and all Task 3 behavior/API for
its existing callers, but ProfileStore must never call that pathname-reopening
entry point. There is one hash/encoder implementation.

`canonicalizeHeldProfileTree()` walks only relative to held generation FDs and
returns bounded fixed-key canonical bytes/tree SHA plus evidence for every
directory and file: relative UTF-8 path, type, dev, ino, nlink, mode, size,
content SHA, parent binding, and open/stat observations. A child found by
enumeration but absent before bind/open creates one in-memory evidence
tombstone and fails unsafe; it never silently shrinks the tree or creates an
on-disk marker.

`syncAndCanonicalizeHeldProfileTree()` first completes that bounded canonical
walk/evidence with zero sync on failure, syncs exactly evidenced files, then
directories in postorder, and finally revalidates the full canonical tree,
including mode/size/content SHA, every inode, and every ancestor/parent binding.
Same-inode mutation is failure.

`copyHeldProfileTree()` first completes bounded source evidence before any
destination copy. It reads source files in bounded chunks through held FDs,
requires exact declared-size bytes followed by EOF, checks stat/binding before
and after reads, rejects prefix/truncation/trailing bytes or content drift,
creates destination entries only through the held destination chain, fsyncs
files then directories postorder, and canonicalizes/revalidates both sides.
Source and destination canonical bytes/tree SHA must match exactly. The copy
uses evidence-driven paths only; it never enumerates an unproved pathname.

Canonicalize, sync, copy, create, prepare, finalize, remove, and launch check
the current binding/admission immediately before and after every filesystem or
launch await. Abort starts no later effect but still runs raw cleanup. The three
tree operations keep Task 3 hooks and exact caps: 25,000
entries, depth 64, 64 MiB per file, 256 MiB per tree, UTF-8/NFC/segment/path,
regular-file, nlink, and special-file rules. Limit failure occurs after bounded
evidence discovery and before sync or destination copy. Every opaque object
attempts every owned descriptor close in raw `finally`. Success, abort,
open/stat failure, revalidation failure, and a close-then-throw injection prove
zero retained FDs. A true close rejection cannot prove descriptor closure: it
retains module-private fail-stop ownership marked `close_unverified`, closes
admission, and makes no zero-FD claim.

ProfileStore is generation-scoped. Startup creates or rebinds exactly one store
to the current ready root; generation rollover drains it and its sessions,
closes the old authority, and mints unready. Later reconciliation reacquires
the root and creates a fresh store before atomically installing both for the
new binding. Every working/staging/committed mutation derives from that
authority.

Derive every path from canonical lowercase UUIDs and permit only exact
`profiles/<profileId>/{working|staging|committed}/<generationId>/` generation
directories. Reuse the held API above without a second checksum implementation:
same held-handle confinement, UTF-8 byte sort,
NFC paths, type/mode/size/content-SHA entries, 64-depth, 64-MiB file, 256-MiB
tree, path/segment, symlink/special/hard-link rejection, and final tree SHA.
Unknown direct children at the profile/state namespace levels fail closed;
bounded content inside a generation is part of the canonical tree. A writer
schema must contain at least one bounded regular file after Chromium closes;
the root-only empty tree fails as `browser_unavailable` with internal detail
`profile_schema_empty` and cannot prepare or
publish. Writer close syncs/canonicalizes a held working tree, renames it to
staging through the held chain, revalidates it, and returns an opaque prepare token.
Finalize verifies token and checksum, atomically renames staging to committed,
and is idempotent for the same generation/checksum. Snapshot sessions never
publish. Child creation/write/file-fsync, postorder directory fsync,
state-rename, removal, and post-mutation revalidation are explicit crash
boundaries. Restart recovery through held evidence either proves the canonical
state or discards the owned partial working/tombstone state; no partial tree is
published, and rename/remove parent directories are fsynced before success.

API advances `latest_generation_id` only after finalize succeeds. Consume the
Task 3 reconciled root; this store never changes readiness, queries authority,
or promotes an orphan generation.

- [ ] **Step 4: Implement persistent Chromium sessions and replay**

Validate all request settings and, for replay, the file/request storage
boundary below before side effects. Create the private provisional Registry
entry before acquiring the first owned resource. Then create a new UUID-derived
isolated working profile for every session, start its loopback proxy with a
closed per-session gate, and launch one
`chromium.launchPersistentContext()` with `headless: true`,
`acceptDownloads: false`, `serviceWorkers: "block"`, validated replay device,
locale, timezone, geolocation, headers, TLS settings, and the exact Task 2
policy `{proxy:{server:loopbackProxyUrl,bypass:"<-loopback>"},args:[
"--disable-quic",
"--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]}`. Unknown
device/timezone/proxy references return `replay_unsupported` before creating a
working copy or launching Chromium.

For a non-replay/profile session, keep that gate closed through persistent
context launch, immediately assert zero violations, and synchronously open it.
Only then may service code acquire or create a page and navigate `initialUrl`:

```ts
const provisional = registry.reserveProvisional(validatedRequest);
const work = await provisional.acquireWorkingCopy();
const proxy = await provisional.acquireEgressProxy({ gate: "restore_closed" });
const context = await provisional.acquirePersistentContext(
  work,
  launchOptionsWithoutStorageState,
);
proxy.restoreGate.assertZeroViolations();
proxy.restoreGate.open();
const page = context.pages()[0] ?? await context.newPage();
await page.goto(validatedRequest.initialUrl);
```

`initialUrl` must supply a positive proxy control in exact order: ingress gate
linearization, DNS resolution, policy decision, then dial. Replay uses the
longer set/export/parse/compare sequence below before the same gate open and
page boundary.

An existing profile generation and a replay checkpoint are mutually
exclusive. Reject that combination as `replay_unsupported` before filesystem,
proxy, or Chromium side effects. Replay may use no profile or a new profile
with null generation; the latter begins empty and may publish only after a
successful session close.

Restore checkpoints only from foundation paths under
`LOCAL_BROWSER_STATE_ROOT`. Require exact
`replay/<owner>/<scrape>/<uuid>.json` grammar, then resolve exactly once as
`join(canonicalRoot, statePath)`. Reject an inserted namespace, doubled
`replay/replay`, or any other prefix; never prepend a second root segment.
`CreateSessionV1` carries the already validated complete
`ReplayCheckpointV1` metadata and storage payload. Resolve
`statePath`, open root-confined with no symlink following, and read at most
2 MiB + 1. The file contains only canonical `StorageStateV1` UTF-8 JSON bytes,
never a full checkpoint envelope. Require raw file length equals request
`byteSize`, raw SHA-256 equals request `checksum`, parse the file with the
closed `StorageStateV1` schema, canonicalize with the existing foundation
stable-JSON algorithm (sorted object keys, original array order), and require
those file-canonical bytes equal both raw bytes and the request storage state
encoded by the same algorithm. This is the only byte/checksum authority.
Reject any raw/file-canonical/request byte, checksum, shape, or value mismatch
before profile/proxy/Chromium creation. Playwright 1.61.1 intentionally omits
`storageState` from `launchPersistentContext()` options and provides
`BrowserContext.setStorageState()` instead. For replay, use a fresh empty
isolated working directory and perform this exact order after the proxy's
closed restore gate is active:

```ts
const provisional = registry.reserveProvisional(validatedRequest);
const work = await provisional.acquireWorkingCopy();
const proxy = await provisional.acquireEgressProxy({ gate: "restore_closed" });
const context = await provisional.acquirePersistentContext(
  work,
  launchOptionsWithoutStorageState,
);
await context.setStorageState(checkpoint.storageState);
const exported: unknown = await context.storageState({ indexedDB: true });
const accepted = storageStateV1Schema.parse(exported);
verifySemanticallyEquivalentStorageState(accepted, checkpoint.storageState);
proxy.restoreGate.assertZeroViolations();
proxy.restoreGate.open();
const page = context.pages()[0] ?? await context.newPage();
```

Each `provisional.acquire*` method attaches its successfully acquired resource
to the same Registry entry before it returns and before the caller's next
fallible await. `acquirePersistentContext()` first attaches a `launch_attempt`
token before invoking Playwright. A returned context atomically replaces that
token with owned context state.

The working-generation value exposes no path. Registry invokes fixed internal
`launchPersistentChromiumForWorking(work, binding, options)` with the genuine
bound working capability and exact current ready binding. The function checks
admission and revalidates the held root→profiles→profile→working→generation
chain before and after every await, constructs and verifies the module-owned
`/proc/<browser-service-pid>/fd/<generation-fd>` string, and directly invokes
`chromium.launchPersistentContext(procfdPath, options)` inside the same module.
The procfd variable's lexical scope ends there; no generic/user callback can
capture it, and neither an FD nor path is returned or stored in Registry.

The fixed launch returns a runtime-authenticated `ChromiumSessionAttachment`
containing the public context while its WeakMap record retains the bound
generation/root lease. `acquirePersistentContext()` attaches both atomically
before its next fallible await. If internal launcher bookkeeping fails after a
context exists, or Registry attachment fails, the acquiring layer immediately
calls `releaseChromiumSessionAttachment()` and aggregates cleanup failure.

`releaseChromiumSessionAttachment()` is the only release path. Its WeakMap
state transition is exactly once: `live → releasing → released` after verified
context closure or verified public Browser fallback closure. It then releases
the generation/root lease. Forged, foreign, double-release, or use-after-release
attachments fail before effect. Unknown/failed close instead moves to retained
`close_unverified`, keeps the attachment and lease under fail-stop ownership,
and closes admission; it never reports release. Swapping/restoring canonical
root, `working` state, or generation pathname before/during launch therefore
uses the original owned inode or fails before Playwright starts.

Persistent Chromium creates and initializes an automatic `about:blank` page
before `launchPersistentContext()` returns. For mobile Chromium, Playwright may
also create a replacement default-context page and close the original during
launch. Its storage APIs may inspect the origin of an existing page, create
library-internal storage helper pages, perform origin navigations under a
prepended route that fulfills every request locally, and evaluate the storage
utility script in its utility world. These are the only page lifecycle,
inspection, navigation, and evaluation operations allowed before semantic
verification on replay. Browser Service and every caller must not acquire
`context.pages()`, call `newPage()`, navigate, use a locator, evaluate script,
or register listener work that can initiate page work until the non-replay
zero-violation check, or replay equality plus zero-violation checks, succeeds
and the gate opens.

Playwright 1.61.1 suppresses public context events for storage helper pages, so
BrowserContext request events are incomplete and are never an egress oracle.
Task 4 extends Task 2's proxy with one per-session restore gate at proxy ingress.
Its recorded categories are exactly `http | connect | upgrade`: the HTTP
request handler records `http`; CONNECT records `connect` for HTTPS and WSS
tunnels; the Upgrade handler records `upgrade` for WS. It never records `ws`
or `wss`. Its state is exactly
`restore_closed | open | closed`. The ingress linearization point precedes DNS
resolution, `onDecision`, and every dial. While `restore_closed`, any ingress
attempt increments the bounded `ingressViolations` counter, records only its
allowlisted protocol category, rejects/closes the request, and performs zero
DNS resolution, policy decision, or dial. An attempt linearized while closed
is never queued or replayed, and its violation permanently disqualifies this
session gate from opening. Non-replay open requires zero violations. Replay
open additionally requires successful export parse and semantic equality.
`open()` is a synchronous one-way compare-and-set from `restore_closed` to
`open` after its applicable conditions succeed. Calling `open()`
from `open` or `closed`, or after any violation, fails with a typed invariant
and changes no state. `close()` reaches terminal `closed` from either prior
state and is idempotent once closed. Counters for ingress attempts, violations,
DNS resolutions, policy decisions, and dials are monotonic safe integers owned
by that session. Every increment is checked before mutation; overflow moves
the gate to terminal `closed`, fails the session, and performs no downstream
DNS, decision, or dial. After opening, non-replay `initialUrl` or replay
`finalUrl` navigation must pass through the same ingress observer and all
existing Task 2 DNS pinning, policy, half-close, backpressure, cancellation,
TLS/SNI, and transport defenses as the positive control.

`verifySemanticallyEquivalentStorageState()` receives each operand as
`unknown` and independently validates the bounded closed schema. It treats
absent `indexedDB` as `[]`, drops origins whose normalized localStorage and
IndexedDB arrays are both empty, omits other absent optional fields, and emits
each element as fixed-key whitespace-free UTF-8 JSON. All tuple components are
length-framed and field-tagged; ordering compares raw UTF-8 bytes, never locale
or UTF-16 order. Each semantic set first sorts by the following primary
identity tuple and then by the full normalized element bytes as a deterministic
tie-breaker:

- cookies: tagged `(domain,path,name,partitionKey-or-absent,
  _crHasCrossSiteAncestor-or-absent)`;
- origins: tagged `(origin)`;
- localStorage entries within one origin: tagged `(name)`;
- IndexedDB databases within one origin: tagged `(name)`;
- stores within one database: tagged `(name)`;
- records within one store: tagged `key:` plus canonical `key` bytes,
  `keyEncoded:` plus canonical `keyEncoded` bytes, `value:` plus canonical
  `value` bytes for inline-key/keyless records, or `valueEncoded:` plus
  canonical `valueEncoded` bytes for inline-key/keyless records;
- indexes within one store: tagged `(name)`.

After sorting, duplicate primary identities are rejected even when their
remaining payload differs. Thus a `key:` payload can never collide with a
`keyEncoded:` payload, and same-primary/different-payload entries are invalid
rather than resolved by the tie-breaker. Duplicates are allowed only inside
ordered value-semantic arrays such as `keyPathArray` and arrays nested inside
JSON-safe key/value encodings; those arrays preserve order and duplicate
members. There are no allowed duplicate identities in the seven semantic-set
arrays above. Require the two semantic-normalized state byte strings to match.
Never
compare semantic-normalized export bytes or hash to raw file bytes/checksum;
foundation-valid files may preserve a different array order. It does not
manually write cookies,
`localStorage`, or IndexedDB. Exact real-Chromium roundtrip fixtures cover
cookies, localStorage, IndexedDB, empty origins, absent versus empty
`indexedDB`, tagged key/keyEncoded and value/valueEncoded collision attempts,
same-primary/different-payload rejection, duplicate identities, non-ASCII raw
byte order, full-array reversal, unsorted keyed records, and unsorted
inline-key records. Only after equality and the zero-violation assertion may
the registry atomically open the restore gate, select an existing launch-owned
page or create one, load `finalUrl` through the positive-control ingress
observer, then compare exact final URL and bounded title/body hashes. Do not
replay saved actions or side effects.

Request/file/settings validation precedes every side effect; its failures have
launch count zero. Registry reserves one private provisional entry before the
first working-copy acquisition and incrementally attaches profile work,
context, proxy/listener/restore gate/live sockets, pending acquisition, and
cleanup state before the next fallible await. A constructor that can partially
acquire before returning must either attach that resource to the provisional
entry or return failure only after its own partial listener, socket, or
filesystem work is verifiably gone. Before Playwright launch,
`acquirePersistentContext()` attaches `launch_attempt` while already owning the
working profile and closed proxy. Never wrap launch in a detached
`Promise.race`. The provisional entry
is not returned by public session lookup and becomes a public runtime session
only after gate opening, navigation, and fingerprint success.

A public Playwright launch rejection or timeout after launch starts does not
prove internal browser-process cleanup. If no context was returned, no public
process handle exists. Only an explicit trusted adapter proof with exact value
`preSpawn` may establish that rejection occurred before any browser process or
resource creation; that path may close the proxy, discard working state, and
remove provisional ownership normally. Never infer `preSpawn` from a rejected
promise.

Without trusted `preSpawn` proof, change the provisional entry to
`cleanup_failed` with `launch_cleanup_unverified`, retain the `launch_attempt`
token and working profile, close/drain the proxy when verifiable, and never
discard, prepare, stage, finalize, or publish the profile. Before returning the
typed `replay_unavailable` or session-unavailable error, atomically record that
retained ownership in the process-local Registry and globally close new-session
admission/readiness for this Browser Service process, or enter its draining
state. The token is never persisted. Unknown Chromium may still write the
profile. Do not inspect or terminate private PIDs/processes.
If proxy closure/drain is not verified, retain those listener/socket handles
and their existing bounded cleanup codes in the same entry.
The sweeper has no public evidence that can clear `launch_cleanup_unverified`.
Browser Service process/container restart is required. Verified restart proves
old Chromium termination and clears only the process-local uncertainty. It
does not create a marker or immediately delete the working generation. Task 3
startup reconciliation sees that generation as an unreferenced recognized
`profiles/<profileId>/working/<generationId>/` entry under its existing exact
grammar and authority. It retains the generation while maximum descendant age
is <=10 minutes and may make readiness true with it retained. Once age is
>10 minutes, a later startup/reconciliation generation removes it through the
existing persisted plan, quarantine rename/fsync, delete/fsync, and completion
rules. No immediate-deletion exception or new marker exists.

After launch returns and replaces the token with an owned context, any
`setStorageState`, immediate export, unknown-export parse,
canonicalization, comparison, gate assertion/open, navigation, or fingerprint
failure; timeout; or Chromium crash runs one idempotent aggregate cleanup. It
calls public `context.close()` exactly once, preserves that original promise,
marks it `closing`, and attaches a settlement observer before applying a
bounded wait. If graceful close rejects or exceeds that observation bound and
closure is not verified, call public `context.browser()?.close()` as the only
force-quit-like fallback and observe it with a bound. A verified context close
or verified browser disconnect is success; preserve observation of the
original context-close settlement even after fallback success. Persistent
contexts may return no Browser, and neither public close API guarantees
success. Never use private Playwright process APIs.

Cleanup also independently performs terminal gate close, proxy listener close,
bounded await of every accepted socket, and, only after context closure is
verified, recursive working-profile discard. One failed step never skips an
independent later cleanup. Terminal gate close is an infallible local state
transition. The thrown typed aggregate preserves only allowlisted specific
codes `chromium_close_failed`,
`proxy_listener_close_failed`, `proxy_socket_drain_failed`, and
`profile_discard_failed`; raw causes stay internal. `profileLifecycleCalls`
means only prepare, stage, finalize, and generation publication; discard is
tracked separately by `profileDiscardAttempts` and `listWorking()`.

After cleanup, remove the provisional entry only when context closure, listener
closure, zero live sockets, and working-profile discard are verified. If any
resource cleanup remains unverified after bounded retries/timeouts, retain the
entry in `cleanup_failed`, keep its admission closed, retain truthful owned
context/Browser handles, original close promises/states, and remaining working
path, and perform no profile
prepare, stage, finalize, or publication. The registry sweeper retries those
public cleanup operations and removes ownership only after every closure and
discard succeeds. It first observes stored promise settlement and may retry
only `browser.close()` when the public Browser state permits; it never calls
`context.close()` again once the original call is `closing`, rejected, or
settled. A service-process restart is the operator fallback for a persistent
public-API cleanup failure; private process handles are forbidden.

Normal writer close uses the same one-shot graceful context close and bounded
public Browser-close fallback, then moves the gate to terminal `closed`,
verifies listener close and zero live sockets, and only then permits profile
preparation. Only complete successful resource shutdown may prepare,
stage, finalize, return the generation, and let API
advance its latest pointer. Snapshot close discards instead. Any cleanup or
publication-step error is aggregated with the cleanup codes above plus
`profile_prepare_failed` or `profile_finalize_failed`, exposes no published
generation to API, retains `cleanup_failed` ownership for any unverified live
resource, and leaves durable partial filesystem state for reconciliation
without skipping remaining cleanup.

Registry accepts `StartupAdmission` and calls `requireReady(binding)` before any
root acquisition, working-copy, proxy, or Chromium side effect. Registry stores public/runtime
IDs, state/version, page/context, proxy/gate/listener/sockets, profile work,
initial/allowed/learned origins, deadlines, DevTools loopback endpoint, stream
hub, and one writer lease. `withWriter()` rejects concurrent mutation with
`concurrency_exceeded`; `touch()` moves only idle deadline. Close is
idempotent, retains truthful `cleanup_failed` ownership on incomplete teardown,
and never prepares a writer profile before verified resource shutdown.

- [ ] **Step 5: Run lifecycle tests**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/profile-store.test.ts src/session-registry.test.ts src/replay-restore.integration.test.ts src/egress-proxy.test.ts src/reconciliation.test.ts src/startup-state.test.ts
```

Expected: PASS for writer exclusion, snapshot isolation, every publication
crash point, corrupt-reference readiness, 600-second idle and 3600-second
absolute maxima, shorter caller limits, and close idempotency. Held-root tests
prove transient ancestor swaps, same-inode drift, child tombstones, exact EOF,
truncation/trailing-byte rejection, phase-specific held mutation chains, first/
completed positive-control hooks, all close attempts, zero retained FDs where
closure is verifiable, fail-stop ownership where it is not, bounds before
sync/copy, empty writer rejection, and one shared Task 3/Task 4 hash/evidence
implementation. Generation rollover tests prove ready clear, acquisition
closure, session/root-lease drain, old-store/root close, and unready mint;
later reconciliation proves capture, reacquisition/store construction, then one
atomic result/authority/store/ready install. Opaque outcomes consume exactly
once; forged/stale/repeated consumption never invokes the install callback.
Real bundled Chromium launches only inside fixed
`launchPersistentChromiumForWorking()` against the retained generation procfd
and proves no path/FD escapes the launcher module.
Canonical root/state/working swaps use the original owned inode or fail before
launch; the attachment holds its root lease through session lifetime and
releases exactly once after verified context/Browser closure. Launcher or
Registry attachment failure cleans it; double release/use after release fails,
while unknown closure retains fail-stop ownership. It also proves cookies,
localStorage, and IndexedDB exist before first
service-owned navigation. Desktop automatic-page initialization, mobile
default-page replacement/close, existing-page origin inspection, helper
pages, fulfilled origin navigations, and utility evaluation remain
Playwright-owned; service/caller page operations remain absent until
verification. Public context events are neither required nor used as proof.
The closed proxy ingress gate records zero `http | connect | upgrade`
violations and therefore zero pre-open DNS resolution, policy decision,
or dial; after atomic open, non-replay `initialUrl` and replay `finalUrl` supply
the positive ingress/DNS/policy/dial control.

Unsorted but foundation-canonical arrays, empty origins, absent versus empty
IndexedDB, tagged key/value representation collisions, duplicate identities,
same-primary/different-payload entries, non-ASCII order, full reversal, and
keyed or inline-key record reordering exercise semantic comparison. The
runtime export enters as `unknown`, and malformed unknown export fails closed.
Tests inspect launch options and exact replay/non-replay call order. Pre-launch
validation failures prove launch count zero. Working-copy, proxy bind/start,
launch rejection/timeout, restore, export, parse, comparison, gate, navigation,
fingerprint, operation-timeout, and Chromium-crash injections assert every
owned resource, discard attempt, working capability, and publication call.
Successful cleanup leaves no Registry/resource/working entry. Failed context/listener/
socket cleanup retains truthful `cleanup_failed` ownership and closed admission
until the sweeper verifies closure; no failure prepares or publishes a profile.
Trusted `preSpawn` rejection proves no browser resource and permits discard.
Launch timeout/post-spawn rejection retains `launch_cleanup_unverified`, working
state, and process-wide closed admission until restart proves termination.
Immediate Task 3 reconciliation retains the <=10-minute working generation and
may reopen readiness; a later generation removes it crash-safely only after
age >10 minutes. Graceful returned-context close rejection/timeout with
successful public Browser close removes ownership; unavailable or failed
Browser fallback retains original close promises and never invokes
`context.close()` twice.

- [ ] **Step 6: Commit profile lifecycle**

```bash
git add apps/browser-service/src/profile-store.ts apps/browser-service/src/profile-store.test.ts apps/browser-service/src/session-registry.ts apps/browser-service/src/session-registry.test.ts apps/browser-service/src/replay-restore.ts apps/browser-service/src/replay-restore.integration.test.ts apps/browser-service/src/egress-proxy.ts apps/browser-service/src/egress-proxy.test.ts apps/browser-service/src/reconciliation.ts apps/browser-service/src/reconciliation.test.ts apps/browser-service/src/startup-state.ts apps/browser-service/src/startup-state.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: persist browser profile generations" -m "Create isolated Chromium working copies and publish writable profile
generations through a checksummed two-phase protocol.

Verify storage-only replay bytes against request metadata before
Chromium, then enforce session writer, idle, and lifetime rules."
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
    const harness = await createFreshActionHarness();
    await expect(harness.executeEvaluateResult(value)).rejects.toMatchObject({
      category: "action_outcome_unknown",
    });
    expect(harness.actionCache.has(harness.action.actionId)).toBe(false);
    expect(harness.session.closed).toBe(true);
    await harness.dispose();
  }
});

test("bounds each result and complete action response", async () => {
  const textHarness = await createFreshActionHarness();
  await expect(textHarness.executeGetText("x".repeat(40_001)))
    .rejects.toMatchObject({
    category: "action_outcome_unknown",
  });
  expect(textHarness.actionCache.size).toBe(0);
  await textHarness.dispose();

  const evaluateHarness = await createFreshActionHarness();
  await expect(evaluateHarness.executeEvaluateResult(
    "x".repeat(32 * 1024 + 1),
  ))
    .rejects.toMatchObject({ category: "action_outcome_unknown" });
  expect(evaluateHarness.actionCache.size).toBe(0);
  await evaluateHarness.dispose();

  const validHarness = await createFreshActionHarness();
  expect(byteLength(validHarness.validatedActionResponse))
    .toBeLessThanOrEqual(128 * 1024);
  await validHarness.dispose();
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/evaluate-policy.test.ts src/operations.test.ts src/action-cache.test.ts
```

Expected: FAIL because operation engine and action cache do not exist.

- [ ] **Step 3: Implement constrained evaluate and stable snapshots**

Import the exact production dependency `typescript@5.9.3` and parse one source
string with `ts.createSourceFile(..., ts.ScriptTarget.Latest, true,
ts.ScriptKind.TS)`. Require zero parse diagnostics and exactly one
`ExpressionStatement`; unwrap only parenthesized expressions. Traverse the
compiler AST with `ts.forEachChild()` and an explicit `SyntaxKind` allowlist.
Reject assignment, update, `new`, import, functions, classes, tagged
templates, and identifiers that provide network, storage, dynamic code,
workers, or navigation mutation. Permit explicit read/call members rooted at
`document`, `location`, and `args`. Do not add a handwritten tokenizer,
regular-expression parser, or fallback parser.

Export `parseAndValidateEvaluateExpression(source)` from
`evaluate-policy.ts`. Tests assert the compiler parser accepts the supported
expression grammar, rejects every forbidden AST node before page evaluation,
and that package metadata places `typescript` in `dependencies`, never only
`devDependencies`.

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
click, inspect the link target and require its origin to already be
authorized; click never learns or reserves an origin. Only explicit
`navigate` may add one validated target origin. Atomically commit that target
origin before browser dispatch, then treat every later dispatch or
serialization failure as ambiguous. Reject uncommitted redirect origins
before following. Track committed plus reserved origins atomically and cap
the total at 8.
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
cd apps/browser-service
corepack pnpm exec vitest run src/evaluate-policy.test.ts src/operations.test.ts src/action-cache.test.ts
corepack pnpm test
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

test("CDP upgrade completes only after the session writer is held", async () => {
  pauseWriterAcquisition();
  const upgrade = openStream("cdp", cdpGrant);
  expect(await promiseState(upgrade)).toBe("pending");
  releaseWriterAcquisition();
  const socket = await upgrade;
  expect(session.writerHeld).toBe(true);
  socket.close();
  await socketClosed(socket);
  expect(session.writerHeld).toBe(false);
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

test("handoff precedes reconciliation while all browser work stays closed", async () => {
  const discovery = await getPrivate("/health/live");
  expect(discovery.status).toBe(200);
  expect(discovery.body).not.toHaveProperty("controlGenerationNonce");
  const generation = await postPrivate(
    "/v1/control-generations", handoffFor(discovery.body.processNonce),
  );
  expect((await getScoped("/health/ready", generation.body)).status).toBe(503);
  expect((await postScoped(
    "/v1/sessions", validCreate, generation.body,
  )).body.category).toBe("reconciliation_required");
  const snapshot = validSnapshotFor(generation.body);
  const reconciled = await postScoped(
    "/v1/reconciliation", snapshot, generation.body,
  );
  expect(reconciled.status).toBe(200);
  expect((await getScoped("/health/ready", generation.body)).body).toMatchObject({
    status: "ready",
    processNonce: snapshot.processNonce,
    controlGenerationNonce: snapshot.controlGenerationNonce,
    snapshotDigest: snapshot.snapshotDigest,
  });
});

test("API takeover closes every old runtime resource before response", async () => {
  await seedReadyGenerationWithAllRuntimeResources();
  const handoff = postPrivate("/v1/control-generations", nextApiHandoff);
  await runtimeDrainStarted();
  expect(await promiseState(handoff)).toBe("pending");
  releaseRuntimeDrain();
  const response = await handoff;
  expect(response.status).toBe(201);
  expect(service.processNonce).toBe(ORIGINAL_PROCESS_NONCE);
  expect(serviceRuntimeInventory()).toEqual({
    sessions: 0, contexts: 0, streams: 0, grants: 0,
    writers: 0, timers: 0, workingProfiles: 0,
  });
  expect(startupAdmission.readyHealth().status).toBe("unready");
});

test("replacement request adopts an orphaned pre-mint server drain", async () => {
  pauseRuntimeDrain();
  const old = postPrivateStreaming(
    "/v1/control-generations", apiAHandoff,
  );
  await runtimeDrainStarted();
  old.abortTransport();
  const replacement = postPrivate(
    "/v1/control-generations", apiBHandoff,
  );
  releaseRuntimeDrain();
  expect((await replacement).body.apiInstanceId)
    .toBe(apiBHandoff.apiInstanceId);
  await expect(retryPrivate(
    "/v1/control-generations", apiAHandoff,
  )).resolves.toMatchObject({
    status: 409,
    body: { category: "control_generation_superseded" },
  });
  expect(runtimeDrainInvocationCount()).toBe(1);
});

test("server caches terminal drain failure before responding", async () => {
  failPhysicalDrainWith("close_deadline_exceeded");
  const first = await postPrivate(
    "/v1/control-generations", apiAHandoff,
  );
  const replay = await postPrivate(
    "/v1/control-generations", apiAHandoff,
  );
  expect(first).toEqual(replay);
  expect(first).toMatchObject({
    status: 503,
    body: {
      category: "control_generation_drain_failed",
      message: "Browser runtime drain failed",
    },
  });
  expect(service.failedHandoffTombstone(apiAHandoff)).toMatchObject({
    detailCode: "close_deadline_exceeded",
  });
  expect(runtimeDrainInvocationCount()).toBe(1);
  expect(service.currentControlGeneration()).toBeNull();
});

test.each([
  "GET /health/live",
  "GET /health/ready",
  "POST /v1/reconciliation",
  "POST /v1/sessions",
  "GET /v1/sessions/:runtimeSessionId",
  "DELETE /v1/sessions/:runtimeSessionId",
  "POST /v1/sessions/:runtimeSessionId/actions",
  "POST /v1/sessions/:runtimeSessionId/grants",
  "DELETE /v1/sessions/:runtimeSessionId/grants/:grantId",
  "POST /v1/sessions/:runtimeSessionId/artifacts",
  "POST /v1/profile-generations/:generationId/finalize",
  "DELETE /v1/profile-generations/:generationId",
  "WS /v1/sessions/:runtimeSessionId/streams/passive",
  "WS /v1/sessions/:runtimeSessionId/streams/interactive",
  "WS /v1/sessions/:runtimeSessionId/streams/cdp",
])(
  "rejects stale generation before touching %s",
  async route => {
    const response = await callPrivateRoute(route, OLD_GENERATION_HEADERS);
    expect(response.status).toBe(409);
    expect(response.body.category).toBe("control_generation_mismatch");
    expect(routeEffects(route)).toEqual([]);
  },
);

test("service restart during handoff cannot return the old process binding", async () => {
  const handoff = postControlGenerationPausedBeforeMint(validHandoff);
  await restartBrowserService();
  releaseControlGenerationMint();
  await expect(handoff).rejects.toMatchObject({
    category: expect.stringMatching(/transport|reconciliation_nonce_mismatch/),
  });
  expect(newService.processNonce).not.toBe(validHandoff.processNonce);
  expect(newService.currentControlGeneration()).toBeNull();
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

test("accepted reconciliation cannot resurrect readiness during shutdown", async () => {
  const accepted = pauseAfterAuthentication(
    "/v1/reconciliation", validSnapshot,
  );
  const shutdown = server.beginShutdown();
  await server.listenerClosed();
  await accepted.continueToAdmission();
  await shutdown;
  expect(reconcileBrowserState).not.toHaveBeenCalled();
  expect(accepted.response()).toMatchObject({
    status: 503,
    body: { category: "reconciliation_required" },
  });
  expect(startupAdmission.readyHealth().status).toBe("unready");
});

test("shutdown aborts accepted reconciliation between filesystem calls", async () => {
  const accepted = postReconciliationPausedAfterFirstRename(validSnapshot);
  await accepted.firstRenameCompleted();
  const shutdown = server.beginShutdown();
  expect(accepted.signal.aborted).toBe(true);
  accepted.releaseFilesystemPause();
  await shutdown;
  expect(accepted.filesystemCallsAfterPause()).toEqual([]);
  expect(accepted.response()).toMatchObject({
    status: 503,
    body: { category: "reconciliation_required" },
  });
  expect(startupAdmission.readyHealth().status).toBe("unready");
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/streams.test.ts src/artifacts.test.ts src/server.test.ts src/dockerfile.test.ts
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
target-creation commands. Complete the authenticated WebSocket upgrade only
after the session writer is acquired; hold it until downstream socket close on
success, error, cancellation, or deadline. Validate URL-bearing commands and
keep egress rules active beneath CDP. Never return the DevTools endpoint.

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

Create `InternalStartupAdmission` with the required ProfileStore factory before
listener bind. Mount authenticated
`GET /health/live`, `POST /v1/control-generations`, `GET /health/ready`, and
`POST /v1/reconciliation` before session routes. Initial live discovery omits
generation headers and never returns the current generation. Control handoff
validates process nonce and the strict API-instance/idempotency pair, closes
admission and aborts reconciliation synchronously, clears ready/cache, and
starts one service-owned registry full-runtime drain before returning 201.
That shared drain closes sessions, contexts, all stream modes, grants,
writers, timers, uncommitted working profiles, root leases, the old
generation-scoped ProfileStore, and its held root. Only after those closes does
handoff return a newly minted generation that is explicitly unready and has no
authority/store. The drain is not cancelled by one request transport. Feed
request close/abort plus its absolute 60-second
deadline into `ControlGenerationRequestContext`. Under the startup-state
handoff mutex, a fresh tuple replaces only an orphaned pre-mint owner and
awaits the same drain; live-owner concurrency remains 409 in-progress.
Physical drain rejection atomically persists an immutable failed tombstone
with typed category/allowlisted detail and no mint. Exact replay returns that
same failure. A fresh tuple starts a new full-inventory idempotent drain, never
the rejected promise or partial cursor. Persist superseded, failed, and minted
results before any response, so old handlers/retries cannot mint and post-mint
caller timeout/disconnect recovers by exact replay.

Every later private request must authenticate both fencing headers before body
parsing or route effects. A stale process or control generation returns typed
409 and performs no registry, filesystem, cache, grant, writer, or handshake
operation. Apply 16 MiB raw JSON limit only to reconciliation and smaller
contract bounds elsewhere. Reconciliation validates service key, correlation,
deadline capped at 60 seconds, process/generation headers, matching body,
schema, and digest before calling
internal `InternalStartupAdmission.reconcileWithAuthority()`. Public `reconcile()` and
`reconcileBrowserState()` retain their existing external/test contracts, but
the HTTP route supplies only the typed execution callback to the controller.
The controller checks non-draining admission, invokes that callback to produce
and consume the opaque outcome internally, reacquires root/builds store, then
atomically installs result/authority/store/readiness. Pass its exact execution
admission through the callback to `reconcileBrowserStateWithAuthority()`; the
route never receives the outcome and cannot extract fields or call
`requireReady()` between steps. A listener-accepted
reconciliation that reaches admission after `beginDraining()` fails without
filesystem access. An in-flight callback observes synchronous abort and may
finish only its current syscall; it starts no later filesystem call, cannot
cache success, and cannot resurrect readiness. Every
create/action/grant/artifact/stream/profile
route invokes `requireReady(binding)` before touching registry or filesystem.

`beginShutdown()` synchronously closes admission and initiates listener close,
then returns one idempotent full-shutdown promise. `listenerClosed()` resolves
only after listener accepts no new connections. Previously accepted requests
then reach closed `requireReady(binding)` admission and settle; shutdown does not wait
for them before they are released. After accepted requests settle, close
streams, close Chromium with bounded profile save, stop timers, and resolve
full-shutdown promise. `SIGTERM` invokes `beginShutdown()` once. Live remains
process liveness only while listener serves it; ready never performs a
disposable session and never becomes true without current generation/digest
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
`corepack pnpm install --frozen-lockfile`. Set the Browser Service package
`WORKDIR` before every Dockerfile Corepack invocation; `dockerfile.test.ts`
rejects any Corepack command that precedes that stage's package `WORKDIR`.
Final runtime starts from the exact
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
install, preflight before start, and non-root user. It also requires exact
`typescript@5.9.3` in production dependencies and in the final image.

- [ ] **Step 7: Run server tests and two real no-cache image builds**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
node apps/browser-service/src/runtime-preflight.mjs
cd apps/browser-service
corepack pnpm exec vitest run src/streams.test.ts src/artifacts.test.ts src/server.test.ts src/dockerfile.test.ts
cd ../..
docker build --pull --no-cache --target browser-test -t firecrawl-local-browser-service:browser-test-1 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:browser-test-1 src/runtime-preflight.mjs
docker run --rm --entrypoint corepack firecrawl-local-browser-service:browser-test-1 pnpm exec vitest run src/chromium-egress.integration.test.ts src/replay-restore.integration.test.ts
docker build --pull --no-cache -t firecrawl-local-browser-service:test-1 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:test-1 --version
docker run --rm --entrypoint node firecrawl-local-browser-service:test-1 -p 'require("playwright/package.json").version'
docker run --rm --entrypoint node firecrawl-local-browser-service:test-1 --input-type=module -e 'const m=await import("./dist/evaluate-policy.js");m.parseAndValidateEvaluateExpression("document.title")'
docker image inspect firecrawl-local-browser-service:test-1 --format '{{.Config.User}}'
docker build --pull --no-cache --target browser-test -t firecrawl-local-browser-service:browser-test-2 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:browser-test-2 src/runtime-preflight.mjs
docker run --rm --entrypoint corepack firecrawl-local-browser-service:browser-test-2 pnpm exec vitest run src/chromium-egress.integration.test.ts src/replay-restore.integration.test.ts
docker build --pull --no-cache -t firecrawl-local-browser-service:test-2 apps/browser-service
docker run --rm --entrypoint node firecrawl-local-browser-service:test-2 --version
docker run --rm --entrypoint node firecrawl-local-browser-service:test-2 -p 'require("playwright/package.json").version'
docker run --rm --entrypoint node firecrawl-local-browser-service:test-2 --input-type=module -e 'const m=await import("./dist/evaluate-policy.js");m.parseAndValidateEvaluateExpression("document.title")'
docker image inspect firecrawl-local-browser-service:test-2 --format '{{.Config.User}}'
```

Expected: tests PASS; both builds succeed from committed digest; each image
reports `v22.22.1`, `1.61.1`, and user `pwuser`. Re-run the raw-manifest
hash and require it equals Dockerfile digest after both builds. Both images
also pass positive-control-proven egress/UDP and storage-restore tests using
their bundled Chromium. Both final production images execute the constrained
evaluate parser smoke successfully, proving `typescript@5.9.3` is present at
runtime. Server tests also prove idempotent control handoff, full runtime
drain-before-mint, stale-generation zero effect across every private route,
and service restart during handoff. An unavailable proof fails the build gate.

- [ ] **Step 8: Commit service transport**

```bash
git add apps/browser-service/src/streams.ts apps/browser-service/src/streams.test.ts apps/browser-service/src/artifacts.ts apps/browser-service/src/artifacts.test.ts apps/browser-service/src/server.ts apps/browser-service/src/server.test.ts apps/browser-service/src/dockerfile.test.ts apps/browser-service/src/index.ts apps/browser-service/Dockerfile
apps/api/.husky/_/pre-commit
git commit -m "feat: serve private browser sessions" -m "Add authenticated control handoff, session, action, profile,
artifact, health, live-view, and CDP transports around Chromium.

Close admission before listeners and prevent reconciliation from
restoring readiness during ordered shutdown."
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
        "x-firecrawl-process-nonce": context.processNonce,
        "x-firecrawl-control-generation-nonce":
          context.controlGenerationNonce,
      }),
    }),
  );
});

it("binds handoff and reconciliation to current process and generation", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(200, liveDiscovery))
    .mockResolvedValueOnce(jsonResponse(201, controlGeneration))
    .mockResolvedValueOnce(jsonResponse(200, reconciliationResult))
    .mockResolvedValueOnce(jsonResponse(200, readyHealth));
  expect(await client.discoverLive(bootstrapContext)).toEqual(liveDiscovery);
  expect(await client.createControlGeneration(
    handoffRequest, bootstrapContext,
  )).toEqual(controlGeneration);
  const canonicalBody = canonicalReconciliationRequestJson(snapshot);
  expect(await client.reconcile(canonicalBody, scopedContext)).toEqual(
    reconciliationResult,
  );
  expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(canonicalBody);
  expect(await client.getReady(scopedContext)).toEqual(readyHealth);
});

it("retries one handoff identity without changing its bytes", async () => {
  fetchMock
    .mockRejectedValueOnce(responseLostAfterServiceCommit())
    .mockResolvedValueOnce(jsonResponse(201, controlGeneration));
  const body = JSON.stringify(handoffRequest);
  await expect(client.createControlGeneration(
    handoffRequest, bootstrapContext,
  )).rejects.toThrow();
  await expect(client.createControlGeneration(
    handoffRequest, bootstrapContext,
  )).resolves.toEqual(controlGeneration);
  expect(fetchBodies()).toEqual([body, body]);
});

it.each([
  "control_generation_in_progress",
  "control_generation_conflict",
  "control_generation_superseded",
  "control_generation_drain_failed",
  "control_generation_history_exhausted",
])("preserves typed bootstrap policy category %s", async category => {
  fetchMock.mockResolvedValueOnce(typedPrivateError(category));
  await expect(client.createControlGeneration(
    handoffRequest, bootstrapContext,
  )).rejects.toMatchObject({ category });
  expect(onControlGenerationMismatch).not.toHaveBeenCalled();
});

it.each([
  "getLive", "getReady", "reconcile", "createSession", "getSession",
  "closeSession", "executeAction", "createRelayGrant", "revokeRelayGrant",
  "fetchArtifact", "finalizeProfile", "discardProfile",
  "openPassiveStream", "openInteractiveStream", "openCdpStream",
])(
  "closes the owning API generation on stale %s response",
  async method => {
    transport.respondWithControlGenerationMismatch(method);
    await expect(callScopedClientMethod(method, CURRENT_BINDING))
      .rejects.toMatchObject({ category: "control_generation_mismatch" });
    expect(onControlGenerationMismatch).toHaveBeenCalledWith(CURRENT_BINDING);
    expect(() => startupGate.assertOpen()).toThrow();
    expect(callEffects(method)).toEqual([]);
  },
);

it("matches the canonical V1 inventory without service imports", () => {
  expect(apiPrivateV1Inventory).toEqual(canonicalPrivateV1Inventory);
  expect(apiPrivateV1Fingerprint).toBe(canonicalPrivateV1Fingerprint);
});

it("rejects uppercase UUIDs and every non-HTTP URL at API parity boundary", () => {
  expect(canonicalUuidSchema.safeParse(VALID_ID.toUpperCase()).success)
    .toBe(false);
  for (const url of ["file:///etc/passwd", "mailto:a@example.test",
    "ftp://example.test/a", "https://user:pass@example.test/"]) {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  }
});

it("rejects representable malformed and oversized HTTP results", async () => {
  for (const response of [
    jsonResponse(200, omittedResultFixture),
    jsonResponse(200, wrongResultKindFixture),
    jsonResponse(200, oversizedGetTextFixture),
    rawJsonResponse(200, RAW_NONFINITE_JSON),
    declaredOversizeResponse(128 * 1024 + 1),
  ]) {
    fetchMock.mockResolvedValueOnce(response);
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
persistence, one canonical `LOCAL_BROWSER_STATE_ROOT`, private HTTP service
URL, and key. That configured root is the direct shared filesystem boundary;
neither API nor service appends an environment namespace layer. Adapter token
absence keeps only host callbacks/prompt/code execution unavailable; it does
not disable direct Browser create/list/delete.

Validate attempts 1..8, initial backoff 100..5,000 ms, maximum backoff greater
than or equal to initial and at most 10,000 ms, startup budget 5,000..60,000
ms, monitor interval 1,000..60,000 ms, and cooldown 5,000..300,000 ms. Tests
lock defaults and reject zero, negative, noninteger, reversed, or out-of-range
values.

- [ ] **Step 4: Implement closed typed client methods**

Implement the exact Locked private contracts again in
`browser-service-contracts.ts`; do not import Browser Service TypeScript.
Export and reuse its sole `canonicalUuidSchema` and `httpUrlSchema` in every
later API protocol/controller schema; forbid local permissive replacements.
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
discoverLive(
  context: BrowserServiceBootstrapRequestContext,
): Promise<LiveDiscoveryV1>;
createControlGeneration(
  request: CreateControlGenerationV1,
  context: BrowserServiceBootstrapRequestContext,
): Promise<ControlGenerationV1>;
getLive(context: BrowserServiceRequestContext): Promise<ScopedLiveHealthV1>;
getReady(context: BrowserServiceRequestContext): Promise<ReadyHealthV1 | UnreadyHealthV1>;
reconcile(
  canonicalRequestBody: string,
  context: BrowserServiceRequestContext,
): Promise<ReconciliationResultV1>;
```

Use the exact Task 1 schemas mirrored at this trusted boundary. Use
`AbortSignal.any([ctx.signal, AbortSignal.timeout(limit)])`. Parse success and
typed errors with Zod. Reject private redirects. Remove any generic
caller-supplied method/path helper. Never include response bodies or private
URLs in public errors.

Construct `BrowserServiceClient` with required
`onControlGenerationMismatch(rejectedBinding)` callback. Every HTTP response,
artifact stream, and WebSocket upgrade/error decoder recognizes the typed
generation mismatch before returning control to its caller and invokes the
callback synchronously. Coordinator compares the rejected binding with its
current binding; on equality it closes the startup gate permanently, aborts
work/retention/monitoring, and never retakes control. A late response for an
older local binding cannot close a newer binding. Client tests enumerate every
scoped HTTP and WebSocket method; no generic transport bypasses this hook.

Generate one canonical `apiInstanceId` per API process and one 32-byte
base64url idempotency key per service-process handoff cycle; never regenerate
either during an exact retry. `BrowserServiceBootstrapRequestContext` carries
no fencing generation. `BrowserServiceRequestContext` requires process and
control-generation nonces and automatically sends both exact headers on every
non-bootstrap method. Callers cannot override or omit them.
`createControlGeneration` preserves typed
`control_generation_in_progress`, `control_generation_conflict`,
`control_generation_superseded`, and
`control_generation_drain_failed`, and
`control_generation_history_exhausted` responses for coordinator startup
policy; only scoped mismatch invokes the permanent current-binding close hook.

`discoverLive` parses only process identity and never accepts a returned
generation. Scoped `getLive` parses only `live_unreconciled`, `reconciling`,
and `ready` with the exact current generation.
`getReady` accepts 200 ready or 503 unready, and `reconcile` caps deadline and
encoded body at 60 seconds and 16 MiB. Every startup method sends bearer key,
correlation ID, and absolute deadline.

`reconcile()` accepts only Task 8's already canonical UTF-8 request string,
sends that exact string as the body, and never reparses or reserializes it.
This preserves byte identity across same-generation retries while response parsing
remains bounded and strict.

All other client methods lock literal method/path/status and parse the exact
request/response schema before or after transport. Artifact fetch validates
metadata headers, media type, declared length, 16 MiB cap, and streamed hash.
Action success parses the operation-specific strict result and 64/128 KiB
caps. A malformed/unsafe response is `browser_service_protocol_error`; after
dispatch the caller must treat it as outcome ambiguity, not no-effect.

Keep cyclic, symbol, bigint, undefined, and accessor fixtures in Task 5's
in-process Browser Service boundary, where those values can exist. API client
HTTP tests use only JSON-representable wrong/omitted discriminants, raw invalid
JSON such as non-finite tokens, declared/actual byte overflows, and oversized
strings. Do not pass a cyclic object through `JSON.stringify()` or claim an
HTTP branch ran when fixture construction failed. A mocked `Response.json()`
object is allowed only in a separate unit test explicitly named as response
decoder isolation; integration/client transport tests consume bytes.

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
fenced client methods for handoff and runtime contracts.

Sanitize transport failures without leaking private endpoints."
```

### Task 8: Gate API startup on authoritative reconciliation

**Files:**
- Create: `apps/api/src/db/migrations/0007_browser_control_generation.sql`
- Modify: `apps/api/src/db/schema/public.ts`
- Modify: `apps/api/src/db/migrate.integration.test.ts`
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
  const gate = createBrowserStartupGate({ pool });
  expect(() => gate.assertOpen()).toThrow(expect.objectContaining({
    category: "browser_state_unavailable",
  }));
  const initialDrain = gate.close("startup");
  await initialDrain.drained;
  gate.open(initialDrain, {
    apiInstanceId: VALID_API_INSTANCE_ID,
    databaseControlEpoch: 7,
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
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
    apiInstanceId: VALID_API_INSTANCE_ID,
    databaseControlEpoch: 7,
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
    snapshotDigest: VALID_DIGEST,
  });
  expect(gate.assertOpen()).toEqual({
    apiInstanceId: VALID_API_INSTANCE_ID,
    databaseControlEpoch: 7,
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
    snapshotDigest: VALID_DIGEST,
  });
});

it("durably fences a paused old-API filesystem/database mutation", async () => {
  const oldMutation = oldApi.gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    async lease => persistCheckpointPausedAfterFileWrite(lease),
  );
  await oldMutation.databaseFenceLocked();
  await oldMutation.fileWriteCompleted();
  const handoff = await newApi.acquireControlGeneration();
  const initialization = newApi.initializeAfterMigrations(handoff);
  await newApi.databaseControlActivationStarted();
  expect(await promiseState(initialization)).toBe("pending");
  expect(newApi.interruptUnfinishedBrowserWork).not.toHaveBeenCalled();
  expect(newApi.loadSnapshot).not.toHaveBeenCalled();
  oldMutation.releaseDatabaseCommit();
  await oldMutation;
  await initialization;
  const newFence = newApi.startupGate.assertOpen();
  expect(newFence.databaseControlEpoch)
    .toBe(oldApi.binding.databaseControlEpoch + 1);
  expect(newApi.snapshotReferences()).toContainEqual(
    expect.objectContaining({ path: oldMutation.checkpointPath }),
  );
  await expect(oldApi.persistAnotherCheckpoint()).rejects.toMatchObject({
    category: "control_generation_mismatch",
  });
  expect(oldApi.secondFilesystemEffects()).toEqual([]);
});

it("creates one constrained monotonic browser control fence", async () => {
  await runMigration("0007_browser_control_generation.sql");
  const first = await activateBrowserControlGeneration(validHandoffA);
  const replay = await activateBrowserControlGeneration(validHandoffA);
  const second = await activateBrowserControlGeneration(validHandoffB);
  expect(replay).toEqual(first);
  expect(second.databaseControlEpoch).toBe(first.databaseControlEpoch + 1);
  await expect(insertSecondSingletonControlRow()).rejects.toThrow();
  for (const invalid of [uppercaseApiId(), malformedProcessNonce(),
    malformedControlNonce(), zeroEpoch()]) {
    await expect(writeControlFence(invalid)).rejects.toThrow();
  }
});

it("loads every nondeleted authority in one repeatable-read snapshot", async () => {
  await seedCheckpoint({
    statePath: "replay/owner-a/scrape-a/44444444-4444-4444-8444-444444444444.json",
  });
  await seedProfileGeneration({ statePath: "profiles/a/committed/1" });
  await seedCleanupIntent({
    statePath: "replay/owner-a/scrape-a/55555555-5555-4555-8555-555555555555.json",
  });
  const snapshot = await loadBrowserReconciliationSnapshot(pool);
  expect(snapshot.references.map(reference => reference.kind).sort()).toEqual([
    "profile_generation",
    "replay_checkpoint",
    "replay_checkpoint_cleanup_intent",
  ]);
  expect(snapshot.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
});

it("reconciles populated foundation replay paths without moving them", async () => {
  const existing = await seedFoundationCheckpointAndCleanupIntent({
    checkpointPath:
      "replay/owner-a/scrape-a/66666666-6666-4666-8666-666666666666.json",
    cleanupPath:
      "replay/owner-a/scrape-a/77777777-7777-4777-8777-777777777777.json",
    cleanupWriterIdentity: "live",
  });
  await startCoordinatorThroughApiLifecycle(coordinator);
  expect(existing.checkpointRow.statePath).toBe(
    "replay/owner-a/scrape-a/66666666-6666-4666-8666-666666666666.json",
  );
  expect(await reloadCheckpointPath(existing.checkpointRow.id)).toBe(
    existing.checkpointRow.statePath,
  );
  expect(await reloadCleanupIntentPath(existing.cleanupIntent.id)).toBe(
    existing.cleanupIntent.statePath,
  );
  expect(await filesystem.read(existing.checkpointRow.statePath))
    .toEqual(existing.checkpointBytes);
  expect(filesystem.rename).not.toHaveBeenCalled();
  expect(filesystem.write).not.toHaveBeenCalled();
  expect(startupGate.assertOpen()).toMatchObject({
    processNonce: VALID_NONCE,
    controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
  });
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

it("reconstructs replay request from metadata plus canonical state file", async () => {
  const marker = "file-only-indexeddb-marker-7cba";
  const capture = checkpointCaptureWithStorageMarker(marker);
  const checkpoint = await persistReplayCheckpoint(capture);
  const bytes = await filesystem.read(checkpoint.statePath);
  expect(bytes).toEqual(canonicalStorageStateBytes(
    capture.storageState,
  ));
  const request = await loadReplayCheckpointForBrowserService(
    checkpoint.ownerId, checkpoint.scrapeId, gate,
  );
  expect(request.storageState).toEqual(capture.storageState);
  expect(bytes.toString("utf8")).toContain(marker);
  const persisted = await loadCheckpointAndEnvelopeJson(checkpoint.scrapeId);
  expect(JSON.stringify(persisted.checkpointRow)).not.toContain(marker);
  expect(JSON.stringify(persisted.envelope)).not.toContain(marker);
  expect(JSON.parse(bytes.toString("utf8"))).not.toHaveProperty("statePath");
  expect(checkpoint.byteSize).toBe(bytes.length);
  expect(checkpoint.checksum).toBe(sha256(bytes));
  expect(checkpointRowColumns()).not.toContain("storage_state");
});

it("fails replay reconstruction on missing or corrupt state file", async () => {
  for (const fixture of [missingStateFile(), checksumMismatchStateFile(),
    noncanonicalStateFile(), oversizedStateFile(2 * 1024 * 1024 + 1)]) {
    const harness = await createFreshReplayStoreHarness(fixture);
    await expect(harness.loadForBrowserService()).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(harness.checkpointRow()).not.toHaveProperty("storageState");
    expect(harness.browserClient.createSession).not.toHaveBeenCalled();
    await harness.dispose();
  }
});
```

The integration test also seeds latest and active-session generations and
proves they are included by the same generation query. It rejects null/malformed
checksum, invalid path, conflicting path aliases, and authority 25,001 instead
of truncating. Hold a concurrent insert after first query and prove it is not
visible in the transaction's later reads.

- [ ] **Step 2: Write failing startup, restart, and retention-order tests**

```ts
it("hands off service control before migrations or database recovery", async () => {
  pauseControlGenerationResponse();
  const startup = startApiWithBrowserCoordinator();
  await controlGenerationRequestStarted();
  expect(runMigrations).not.toHaveBeenCalled();
  expect(databasePool.connect).not.toHaveBeenCalled();
  expect(createDatabaseBackedBrowserStores).not.toHaveBeenCalled();
  expect(bindApiListener).not.toHaveBeenCalled();
  expect(startWorkers).not.toHaveBeenCalled();
  expect(startOperationalRetention).not.toHaveBeenCalled();
  expect(interruptUnfinishedBrowserWork).not.toHaveBeenCalled();
  expect(loadSnapshot).not.toHaveBeenCalled();
  releaseControlGenerationResponse();
  await startup;
  expect(events).toEqual([
    "gate:close",
    "browser-retention:pause",
    "service:live-discovery",
    "service:control-generation",
    "migrations",
    "database-control:activate",
    "api-mutations:drained",
    "recovery:interrupt",
    "cleanup-intents:recover",
    "snapshot:repeatable-read",
    "service:reconcile",
    "service:ready",
    "gate:open",
    "browser-retention:start",
  ]);
});

it("handoff failure exits before database or API side effects", async () => {
  createControlGeneration.mockRejectedValue(controlHandoffUnavailable());
  await expect(startApiWithBrowserCoordinator()).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  expect(runMigrations).not.toHaveBeenCalled();
  expect(databasePool.connect).not.toHaveBeenCalled();
  expect(createDatabaseBackedBrowserStores).not.toHaveBeenCalled();
  expect(bindApiListener).not.toHaveBeenCalled();
  expect(startWorkers).not.toHaveBeenCalled();
  expect(startOperationalRetention).not.toHaveBeenCalled();
});

it("browser-disabled API still owns and runs its migrations", async () => {
  await startApi({ LOCAL_BROWSER_SERVICE_ENABLED: "false" });
  expect(createBrowserReconciliationCoordinator).not.toHaveBeenCalled();
  expect(runMigrations).toHaveBeenCalledTimes(1);
  expect(events.indexOf("migrations"))
    .toBeLessThan(events.indexOf("api:listener"));
});

it("API-only restart drains old service work and accepts changed state", async () => {
  await firstApi.createCheckpointProfileAndEveryRuntimeResource();
  const oldBinding = firstApi.startupGate.assertOpen();
  const restarted = createApiProcessForSameServiceAndDatabase();
  await restarted.start();
  expect(restarted.serviceProcessNonce).toBe(oldBinding.processNonce);
  expect(restarted.controlGenerationNonce)
    .not.toBe(oldBinding.controlGenerationNonce);
  expect(restarted.snapshotDigest).not.toBe(oldBinding.snapshotDigest);
  expect(serviceRuntimeInventory()).toEqual({
    sessions: 0, contexts: 0, streams: 0, grants: 0,
    writers: 0, timers: 0, workingProfiles: 0,
  });
  await expect(firstApi.client.createSession(validCreate, oldBinding))
    .rejects.toMatchObject({ category: "control_generation_mismatch" });
  expect(() => firstApi.startupGate.assertOpen()).toThrow();
  expect(restarted.startupGate.assertOpen()).toMatchObject({
    processNonce: oldBinding.processNonce,
    controlGenerationNonce: restarted.controlGenerationNonce,
    snapshotDigest: restarted.snapshotDigest,
  });
});

it("old API shutdown after takeover cannot affect the new generation", async () => {
  await oldApi.start();
  await newApi.startAndTakeControl();
  const binding = newApi.startupGate.assertOpen();
  await oldApi.stop();
  expect(oldApi.scopedCloseAttempts()).toEqual([
    expect.objectContaining({ category: "control_generation_mismatch" }),
  ]);
  expect(newApi.startupGate.assertOpen()).toEqual(binding);
  await expect(newApi.client.createSession(validCreate, binding))
    .resolves.toMatchObject({ state: "ready" });
});

it("old API shutdown racing active handoff cannot close new resources", async () => {
  await oldApi.start();
  pauseOldApiShutdownBeforeScopedCloses();
  const stopping = oldApi.stop();
  await oldApiShutdownPaused();
  const takeover = newApi.startAndTakeControl();
  await newApiControlDrainStarted();
  releaseOldApiShutdown();
  await stopping;
  await takeover;
  expect(oldApi.scopedCloseAttempts()).toEqual([
    expect.objectContaining({ category: "control_generation_mismatch" }),
  ]);
  expect(service.binding()).toMatchObject({
    controlGenerationNonce: newApi.controlGenerationNonce,
  });
  expect(newApi.startupGate.assertOpen()).toMatchObject({
    controlGenerationNonce: newApi.controlGenerationNonce,
  });
});

it("serializes concurrent API startups and fences the earlier winner", async () => {
  pauseFirstControlDrain();
  const first = apiA.start();
  const second = apiB.start();
  await expect(apiB.firstControlAttempt()).rejects.toMatchObject({
    category: "control_generation_in_progress",
  });
  releaseFirstControlDrain();
  await first;
  await second;
  expect(apiB.controlGenerationNonce)
    .not.toBe(apiA.controlGenerationNonce);
  expect(() => apiA.startupGate.assertOpen()).toThrow();
  expect(apiB.startupGate.assertOpen()).toMatchObject({
    controlGenerationNonce: apiB.controlGenerationNonce,
  });
  expect(await loadDurableControlFence()).toMatchObject({
    apiInstanceId: apiB.apiInstanceId,
    controlGenerationNonce: apiB.controlGenerationNonce,
  });
});

it("replays one in-process tuple after post-mint response loss", async () => {
  const api = createApiProcessWithFixedInstanceIdentity();
  loseControlTransportAt("after_service_mint_before_response");
  await expect(api.start()).rejects.toThrow();
  await api.retryStartupInSameProcess();
  expect(api.controlRequestBodies()).toHaveLength(2);
  expect(api.controlRequestBodies()[1]).toBe(api.controlRequestBodies()[0]);
  expect(api.controlGenerationMintCount()).toBe(1);
  expect(api.databaseRecoveryCount()).toBe(1);
});

it.each([
  { crashPoint: "before_control_request_send", drains: 1, mints: 1 },
  { crashPoint: "during_pre_mint_drain", drains: 1, mints: 1 },
  { crashPoint: "after_service_mint_before_response", drains: 2, mints: 2 },
])("replacement API uses a fresh tuple after process crash $crashPoint",
  async ({ crashPoint, drains, mints }) => {
    const crashed = createApiProcess();
    await crashApiProcessAt(crashed, crashPoint);
    const replacement = createApiProcessForSameServiceAndDatabase();
    await replacement.start();
    expect(replacement.apiInstanceId).not.toBe(crashed.apiInstanceId);
    expect(replacement.idempotencyKey).not.toBe(crashed.idempotencyKey);
    expect(service.runtimeDrainCount()).toBe(drains);
    expect(service.controlGenerationMintCount()).toBe(mints);
    if (crashPoint === "during_pre_mint_drain") {
      await expect(service.retryTuple(crashed.controlTuple))
        .rejects.toMatchObject({
          category: "control_generation_superseded",
        });
    }
    expect(crashed.databaseRecoveryCount()).toBe(0);
    expect(replacement.databaseRecoveryCount()).toBe(1);
    expect(replacement.startupGate.assertOpen()).toMatchObject({
      controlGenerationNonce: replacement.controlGenerationNonce,
    });
  },
);

it("coalesces restart detection and never resumes old sessions", async () => {
  await startCoordinatorThroughApiLifecycle(coordinator);
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

it("abandons handoff when service process changes before generation", async () => {
  pauseControlGenerationRequestFor(OLD_NONCE);
  const startup = coordinator.acquireControlGeneration();
  restartServiceWithNonce(NEW_NONCE);
  releaseControlGenerationRequest();
  await expect(startup).resolves.toMatchObject({ processNonce: NEW_NONCE });
  expect(controlRequestsFor(OLD_NONCE)).toHaveLength(1);
  expect(controlRequestsFor(NEW_NONCE)).toHaveLength(1);
  expect(interruptUnfinishedBrowserWork).not.toHaveBeenCalled();
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
  await expect(startCoordinatorThroughApiLifecycle(coordinator))
    .rejects.toMatchObject({
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

it("holds same failed process/generation binding for cooldown", async () => {
  await exhaustRuntimeCycleForBinding(VALID_BINDING);
  fakeClock.advanceBy(29_999);
  await fakeClock.runDueTimers();
  expect(serviceClient.reconcile).toHaveBeenCalledTimes(4);
  await coordinator.checkNow();
  expect(serviceClient.reconcile).toHaveBeenCalledTimes(8);
});

it("retries byte-identical reconciliation after partial execution", async () => {
  serviceClient.reconcile
    .mockRejectedValueOnce(reconciliationCleanupFailed())
    .mockResolvedValueOnce(reconciliationResult);
  await startCoordinatorThroughApiLifecycle(coordinator);
  expect(reconcileBodies).toHaveLength(2);
  expect(reconcileBodies[1]).toEqual(reconcileBodies[0]);
  expect(reconcileDigests).toEqual([snapshotDigest, snapshotDigest]);
  expect(loadSnapshot).toHaveBeenCalledTimes(1);
});

it("recovers a lost success response through same-digest cache", async () => {
  serviceClient.reconcile
    .mockRejectedValueOnce(responseLostAfterServiceCommit())
    .mockResolvedValueOnce(reconciliationResult);
  await startCoordinatorThroughApiLifecycle(coordinator);
  expect(reconcileBodies[1]).toEqual(reconcileBodies[0]);
  expect(interruptUnfinishedBrowserWork).toHaveBeenCalledTimes(1);
  expect(loadSnapshot).toHaveBeenCalledTimes(1);
  expect(startupGate.assertOpen()).toMatchObject({ snapshotDigest });
});

it("performs a new handoff before recovery when process nonce changes", async () => {
  serviceClient.reconcile.mockRejectedValueOnce(new TransportClosedError());
  serviceClient.discoverLive
    .mockResolvedValueOnce(liveDiscoveryFor(OLD_NONCE))
    .mockResolvedValueOnce(liveDiscoveryFor(NEW_NONCE));
  await startCoordinatorThroughApiLifecycle(coordinator);
  expect(serviceClient.createControlGeneration).toHaveBeenCalledTimes(2);
  expect(interruptUnfinishedBrowserWork).toHaveBeenCalledTimes(2);
  expect(loadSnapshot).toHaveBeenCalledTimes(2);
  expect(reconcileBodiesFor(OLD_NONCE)).toHaveLength(1);
  expect(reconcileBodiesFor(NEW_NONCE)).toHaveLength(1);
  expect(reconcileBodiesFor(NEW_NONCE)[0])
    .not.toEqual(reconcileBodiesFor(OLD_NONCE)[0]);
});

it("rechecks live nonce after snapshot before the first post", async () => {
  pauseAfterFrozenSnapshotFor(OLD_NONCE);
  const initialization = startCoordinatorThroughApiLifecycle(coordinator);
  await frozenSnapshotReached();
  restartServiceWithNonce(NEW_NONCE);
  releaseFrozenSnapshotPause();
  await initialization;
  expect(reconcileBodiesFor(OLD_NONCE)).toEqual([]);
  expect(interruptUnfinishedBrowserWork).toHaveBeenCalledTimes(2);
  expect(loadSnapshot).toHaveBeenCalledTimes(2);
  expect(reconcileBodiesFor(NEW_NONCE)).toHaveLength(1);
});

it("stop aborts retry and cannot reopen the gate", async () => {
  pauseReconcileAttempt();
  const initialization = startCoordinatorThroughApiLifecycle(coordinator);
  await reconcileAttemptStarted();
  const stopping = coordinator.stop();
  expect(reconcileAttemptSignal.aborted).toBe(true);
  releaseReconcileAttempt();
  await stopping;
  await expect(initialization).rejects.toMatchObject({
    category: "browser_state_unavailable",
  });
  expect(startBrowserRetention).not.toHaveBeenCalled();
  expect(() => startupGate.assertOpen()).toThrow();
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

Add mismatched process/generation/digest results, ready mismatch, handoff
timeout/partial drain, auth, transport, database, malformed response,
interrupted recovery, concurrent API takeover, and second-reconciliation
failure cases. Each leaves gate closed and retention paused. Assert no database
recovery/snapshot precedes confirmed handoff, stale API generations cannot
mutate or open streams, public mapping is only `browser_state_unavailable`,
and logs omit paths, IDs, hashes, either nonce, bearer key, private/database
URLs, profile/browser identity, capability, and grant.

Add fake-clock retry tests. Handoff and reconciliation attempts start
immediately, then wait exactly 250, 500, and 1,000 ms before attempts 2, 3,
and 4. A 60,000 ms total startup budget spans discovery, handoff, migrations,
recovery, snapshot, reconciliation, and ready verification; it caps every
request deadline and cancels remaining backoff. Initial exhaustion throws
sanitized `browser_state_unavailable` so API startup fails and registered
cleanup runs. Runtime exhaustion keeps API alive but gate closed; the same
failed process/generation binding cannot start another cycle for 30,000 ms.
A changed process nonce or explicit `checkNow()` starts one new coalesced
bounded cycle. Stale generation never invokes `checkNow()` takeover.

For each confirmed service process/control generation, closed database
recovery runs exactly once, then the coordinator captures one immutable
repeatable-read snapshot and canonical UTF-8 serialization of the complete
reconciliation request. Freeze those bytes and its digest before attempt 1. A
retry for partial execution,
transport failure, timeout, or a response lost after service success resends
the byte-identical body; it never reruns cleanup recovery or reloads the
snapshot while the generation remains stable. The service's same-process,
same-generation, same-digest cached result makes lost-response replay safe.
Validation or auth failure is nonretryable.

Read authenticated generation-scoped live health immediately before every
reconciliation POST, including attempt 1 after snapshot freeze and every
retry. If process nonce differs, abort the old attempt loop, discard its
frozen request, complete a new handoff, then rerun database recovery and
snapshot under the new generation. If control generation differs while
process nonce is stable, another API owns control: permanently close this API
gate and send no further private mutation. A crash or restart between attempts
can never receive an old-generation request. Four attempts and
250/500/1,000 ms backoff apply to each coalesced generation cycle. One
60-second outer startup budget spans process churn and control retries; it
never resets on service churn. Each runtime cycle has its own 60-second
budget. Runtime exhaustion holds that exact binding for 30-second cooldown.
Explicit `checkNow()` may override cooldown but still creates only one new
coalesced cycle when this API retains generation authority.

- [ ] **Step 3: Run focused tests and verify red**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/db/migrate.integration.test.ts src/lib/browser-runtime/startup-gate.test.ts src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts src/lib/browser-runtime/reconciliation-coordinator.test.ts src/lib/browser-state/store.integration.test.ts src/lib/scrape-interact/replay-store.integration.test.ts src/services/local-retention-worker.test.ts
```

Expected: FAIL because gate, snapshot loader, and coordinator do not exist and
retention does not wait for reconciliation.

- [ ] **Step 4: Implement gate and repeatable-read authority loader**

Expose exact gate methods:

```ts
export type BrowserStartupBinding = {
  apiInstanceId: string;
  databaseControlEpoch: number;
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
};

export type BrowserMutationDrain = {
  epoch: number;
  drained: Promise<void>;
};

export type BrowserControlFenceTransaction = Pick<PoolClient, "query"> & {
  readonly databaseControlEpoch: number;
};

export type BrowserStateMutationLease = {
  readonly epoch: number;
  readonly scope: "filesystem_and_database";
  readonly binding: BrowserStartupBinding;
  readonly transaction: BrowserControlFenceTransaction;
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

export function createBrowserStartupGate(deps: {
  pool: Pick<Pool, "connect">;
}): BrowserStartupGate;
```

Gate starts closed. `close()` synchronously makes later admission and mutation
leases fail, increments epoch, and returns one drain whose promise settles only
after every earlier lease releases. One lease covers filesystem side effect
and matching database compare-and-set as one mutation. After process-local
registration, every normal lease begins a database transaction, locks the
singleton `browser_control_generation` row `FOR UPDATE`, and requires exact
API instance/process/control nonce/database epoch equality. It holds that row
lock and transaction across every filesystem operation plus matching database
write, then commits before releasing in `finally`. A stale process can perform
no later filesystem effect even if its local gate remains open. Never acquire
separate filesystem and database leases or release the durable fence between
file and row mutation. `open()` accepts only current drained epoch and
coordinator's validated process/generation/digest binding; stale drains cannot
reopen gate.
`withDrainedBrowserStateMutation()` accepts only current fully drained token,
runs coordinator recovery while admission remains closed, and uses the same
durable row-lock/transaction fence for every recovery filesystem/database
effect before snapshot may start. It cannot overlap a normal lease or be
called by routes.
Every later API mutator receives this gate as an explicit constructor or
function dependency. No browser-state filesystem or database mutator is
exported to controllers as an unleased callback. Read-only operations may use
`assertOpen()`; `assertOpen()` alone never authorizes a mutation.

Migration `0007_browser_control_generation.sql` creates one singleton row
shape with `singleton_id=1`, positive bigint database epoch, canonical process
and control nonces, canonical API instance UUID, and activation timestamp.
First activation inserts epoch 1; later activation locks the row and increments
exactly once. While holding that row lock, activation calls generation-scoped
live health for the proposed binding, writes it only if still current, commits,
then rechecks scoped live before any recovery. A concurrent newer handoff makes
the older activation roll back or fail its post-commit check; it never runs
recovery or opens a gate. Exact same binding activation is idempotent. Migration
tests enforce singleton/check/immutability rules and Drizzle parity.

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

- [ ] **Step 6: Implement handoff-first reconciliation coordinator**

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
    "discoverLive" | "createControlGeneration" | "getLive" |
    "getReady" | "reconcile">;
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

export type BrowserControlGenerationHandoff = {
  apiInstanceId: string;
  idempotencyKey: string;
  processNonce: string;
  controlGenerationNonce: string;
  canonicalRequestBody: string;
  drain: BrowserMutationDrain;
};

export type BrowserReconciliationCoordinator = {
  acquireControlGeneration(
    signal?: AbortSignal,
  ): Promise<BrowserControlGenerationHandoff>;
  initializeAfterMigrations(
    handoff: BrowserControlGenerationHandoff,
    signal?: AbortSignal,
  ): Promise<BrowserStartupBinding>;
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

Generate one canonical UUID `apiInstanceId` at API process start and retain it
for that process lifetime. For each discovered Browser Service process nonce,
generate one 32-byte base64url idempotency key and freeze the exact control
request bytes. `acquireControlGeneration()` calls `gate.close()`, pauses
browser-state retention, discovers live process identity, then posts that
exact handoff request. An exact-byte retry may recover a cached minted result
or join a still-live owner, but cannot revive a pre-mint orphan or superseded
tuple. `control_generation_superseded` fails this API startup; only a fresh API
process with a fresh API instance/key tuple can adopt that service-owned drain.
If live process identity changes, abandon the old request, generate one new
handoff key for the new process, and retry within the same outer startup
budget. It returns only after response process/API identity match and service
drain has completed, carrying the original still-closed API drain token forward
to initialization. No migration, database recovery, cleanup-intent access,
snapshot query, or claim about interrupted Chromium occurs before this return.

On every enabled API startup, including first startup, `index.ts` constructs
the closed gate/client/coordinator and invokes `acquireControlGeneration()`
before opening PostgreSQL for startup work or applying database migrations.
Only after confirmed handoff does it apply migrations, then call
`initializeAfterMigrations()` with that exact handoff to run every remaining
coordinator phase. Pool configuration and `createBrowserStartupGate({ pool })`
may be constructed before handoff only if construction is lazy and performs no
connection, query, migration, or database-backed store initialization. Do not
bind listeners, construct DB-backed browser stores, start workers, or start
any retention before handoff succeeds. Under the existing mutex,
initialization first activates the durable
database control fence using the locked-row/scoped-live protocol above. This
waits for every older cross-process mutation holding the row and rejects a
superseded handoff. Only after activation and its post-commit service recheck
does initialization await the API mutation drain and call
`gate.withDrainedBrowserStateMutation(drain, ...)` once around
`interruptUnfinishedBrowserWork(now)` and exact-process cleanup-intent
recovery. Only now may API classify durable work interrupted; Browser Service
runtime closure was already confirmed by handoff. After that wrapper resolves,
read generation-scoped live health and capture
the repeatable-read snapshot, post `{version:1,processNonce,
controlGenerationNonce,snapshotDigest,references}`, validate the closed result, fetch ready
health, and require both responses equal requested process/generation/digest.
Then `gate.open(drain, binding)` and
start browser-state retention. Each request deadline is the smaller of its
configured timeout and the remaining 60,000 ms startup budget.

For one observed service process/control generation, run closed recovery once
and serialize the complete request once with the canonical Task 1 encoder.
Freeze the exact UTF-8 body, references, and digest for that generation cycle.
Every same-generation
attempt, including partial-execution error, transport loss, timeout, or lost
success response, posts those byte-identical bytes. Recheck live health
immediately before every POST, including attempt 1. If the binding changed,
abort and discard the old cycle before any post. A changed process nonce
requires a new handoff before database recovery repeats. A changed control
generation with the same process means another API superseded this one: close
the gate permanently, stop browser retention/monitoring, reject browser work,
and never attempt to retake control automatically. Never send an old-generation
body to a new generation or recapture a different digest inside one stable
generation.

Every API-only restart performs a fresh handoff even if process nonce is
unchanged. The completed service drain clears old reconciliation cache, so the
new generation may reconcile a different durable digest. Within one generation,
exact digest replay remains cached and a different digest remains
`reconciliation_conflicting_replay`. `stop()` aborts the current request or
backoff, waits for the mutex, and permanently prevents later gate open or
retention start. Graceful API shutdown first closes/drains its API gate, then
uses its still-current generation to close owned sessions/grants and waits for
writers/streams before stopping monitoring; it never mints another generation.
Crash cleanup is deferred to the next startup handoff.

`checkNow()` fetches generation-scoped ready health. Any 503, changed process
nonce, changed generation, changed digest, transport/auth/schema error, or
process restart closes gate immediately. Process restart runs a new handoff
then the same recovery sequence. Stale generation means this API lost control
and terminates its browser coordinator without takeover. Concurrent detections
share one promise. Old model threads/actions are interrupted only after a
confirmed handoff has already closed service runtimes. None resume. One cycle
has at most 4 attempts. Attempt 1 starts
immediately; attempts 2..4 wait 250, 500, and 1,000 ms, each capped by remaining
60,000 ms cycle budget. Startup exhaustion rejects initialization and API
startup cleanup runs. Runtime exhaustion leaves gate closed, pauses retention,
records failed binding, and suppresses same-binding automatic retry for
30,000 ms; process nonce change or explicit `checkNow()` may start one new
coalesced cycle while generation authority remains current. No
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

Preserve foundation replay ownership. `filesystem-store.ts` remains sole owner
of root-confined `StorageStateV1` write/read/delete at exact
`replay/<owner>/<scrape>/<uuid>.json` paths. `replay-store.ts` remains owner of
checkpoint metadata rows and cleanup intents. Under one browser-state
mutation lease, use the existing stable canonical JSON algorithm to write
only storage-state bytes, fsync/rename first, then persist existing metadata:
`state_path`, final URL, fingerprint, byte size, and SHA-256. Do not add a
storage payload column or an unrelated schema migration.

For replay session creation, validate the owned checkpoint row and envelope,
then read through existing `BrowserStateFilesystem.readCheckpoint()` while
the gate/lease is valid. Require direct-root path grammar, the foundation
2 MiB file/metadata bound, byte count, SHA-256, and closed canonical
`StorageStateV1`. Reconstruct `ReplayCheckpointV1` from database metadata plus
that parsed file for the Browser Service request. Browser Service independently
reopens the same direct-root path and compares request/file bytes. The private
HTTP envelope may retain its 16 MiB transport cap, but a checkpoint over 2 MiB
is rejected before transport. Existing populated foundation checkpoint and
cleanup-intent paths are read in place; never rewrite a database path, move a
file to a new root layer, or add a PostgreSQL storage-state column.
No filesystem-layout migration is added because the direct-root foundation
layout remains canonical.

Wrap browser-state file creation, profile publication/discard, checkpoint
materialization/cleanup, and retention deletion in
`gate.withBrowserStateMutationLease("filesystem_and_database", ...)`. Make the
browser phase call `waitUntilOpen(signal)` before each iteration. `index.ts`
must construct the coordinator and finish `acquireControlGeneration()` before
migrations, then run migrations and invoke `initializeAfterMigrations()`
before browser routes admit work. No combined `start()` method may hide or
reorder this boundary.

This gate is mandatory dependency for later mutation boundaries: Task 9
session/profile/run create, attach, transition, and stop; Task 10 action and
capability state; Task 11 grants and artifact manifest/run attachment; Tasks
12-13 controller-facing operations. Each later task adds its race tests. No
constructor accepts an optional gate, and no enabled-local-mode test may use a
pass-through mutation executor.

- [ ] **Step 7: Run integration tests serially and build**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/db/migrate.integration.test.ts src/lib/browser-runtime/startup-gate.test.ts src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts src/lib/browser-runtime/reconciliation-coordinator.test.ts src/lib/browser-state/store.integration.test.ts src/lib/scrape-interact/replay-store.integration.test.ts src/services/local-retention-worker.test.ts
pnpm --dir apps/api build
```

Expected: tests PASS with one shared-schema worker; build PASS. Snapshot,
durable control migration/fencing, paused-old-mutation drain, recovery, gate,
retention, restart, retry, and redaction order are locked.

- [ ] **Step 8: Commit API startup reconciliation**

```bash
git add apps/api/src/db/migrations/0007_browser_control_generation.sql apps/api/src/db/schema/public.ts apps/api/src/db/migrate.integration.test.ts apps/api/src/lib/browser-runtime/startup-gate.ts apps/api/src/lib/browser-runtime/startup-gate.test.ts apps/api/src/lib/browser-runtime/reconciliation-snapshot.ts apps/api/src/lib/browser-runtime/reconciliation-snapshot.integration.test.ts apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts apps/api/src/lib/browser-runtime/reconciliation-coordinator.test.ts apps/api/src/lib/browser-state/store.ts apps/api/src/lib/browser-state/store.integration.test.ts apps/api/src/lib/browser-state/filesystem-store.ts apps/api/src/lib/scrape-interact/replay-store.ts apps/api/src/lib/scrape-interact/replay-store.integration.test.ts apps/api/src/services/local-retention-worker.ts apps/api/src/services/local-retention-worker.test.ts apps/api/src/index.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: gate browser startup on reconciliation" -m "Fence durable mutations with a monotonic database control epoch, then
recover one repeatable-read snapshot after service handoff.

Store replay files as canonical storage-only bytes and coalesce recovery
when service process or control generation changes."
```

### Task 9: Define one-job execution boundary and session orchestrator

**Files:**
- Create: `apps/api/src/db/migrations/0008_browser_adapter_bindings.sql`
- Modify: `apps/api/src/db/schema/public.ts`
- Modify: `apps/api/src/db/migrate.integration.test.ts`
- Create: `apps/api/src/lib/browser-runtime/protocol.ts`
- Create: `apps/api/src/lib/browser-runtime/protocol.test.ts`
- Create: `apps/api/src/lib/browser-runtime/execution-adapter.ts`
- Create: `apps/api/src/lib/browser-runtime/execution-adapter.test.ts`
- Create: `apps/api/src/lib/browser-runtime/orchestrator.ts`
- Create: `apps/api/src/lib/browser-runtime/orchestrator.test.ts`
- Modify: `apps/api/src/lib/browser-state/types.ts`
- Modify: `apps/api/src/lib/browser-state/store.ts`
- Modify: `apps/api/src/lib/browser-state/store.integration.test.ts`
- Create: `apps/api/src/lib/browser-state/capability-store.ts`
- Create: `apps/api/src/lib/browser-state/capability-store.test.ts`

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

it.each(["prompt", "code"] as const)(
  "persists exact job and supervisor before %s adapter dispatch",
  async mode => {
    const harness = await createFreshAdapterHarness(mode);
    harness.onAdapterExecute(async input => {
      expect(await harness.loadRunBinding(input.runId)).toEqual({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: null,
      });
      expect(await harness.loadCapabilityBinding(input.runId)).toMatchObject({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: null,
        activatedAt: null,
      });
      await input.onAccepted({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: 4242,
      });
      expect(harness.acceptedBinding()).toEqual({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: 4242,
      });
      return mode === "prompt" ? validPromptResult : validCodeResult;
    });
    await harness.execute();
    expect(await harness.loadRunBinding()).toMatchObject({
      adapterProcessId: 4242,
    });
    expect(await harness.loadCapabilityBinding()).toMatchObject({
      adapterProcessId: 4242, activatedAt: expect.any(Date),
    });
    await harness.dispose();
  },
);

it("rejects wrong first-callback job and stale process bindings", async () => {
  await persistAndActivateAdapterBinding(validBinding);
  for (const binding of [
    { ...validBinding, adapterJobId: OTHER_JOB_ID },
    { ...validBinding, adapterSupervisorId: OTHER_SUPERVISOR_ID },
    { ...validBinding, adapterProcessId: 4243 },
  ]) await expect(authorizeFirstCallback(runId, binding))
    .rejects.toMatchObject({ category: "capability_denied" });
  expect(await authorizeFirstCallback(runId, validBinding)).toMatchObject({
    runId, adapterJobId: validBinding.adapterJobId,
  });
});

it("restart recovery revokes unactivated and stale adapter capability", async () => {
  await persistStartingBinding(validBindingWithoutProcess);
  await interruptUnfinishedBrowserWork(now);
  expect(await runState(runId)).toBe("interrupted");
  expect(await capabilityState(runId)).toBe("revoked");
  await expect(activateAdapterProcess(validBinding))
    .rejects.toMatchObject({ category: "capability_denied" });
});

it("migrates a populated valid legacy capability after dropping not null", async () => {
  const legacy = await seedLegacyCapability({ adapterProcessId: 4242 });
  await runMigration("0008_browser_adapter_bindings.sql");
  expect(await loadMigratedCapability(legacy.id)).toMatchObject({
    adapterProcessId: null,
    adapterJobId: null,
    adapterSupervisorId: null,
    activatedAt: null,
    revokedAt: expect.any(Date),
  });
});

it("aborts populated migration before any change for noncanonical job", async () => {
  const before = await seedPopulatedLegacyDatabase({
    actionAdapterJobId: VALID_JOB_ID.toUpperCase(),
    capabilityAdapterProcessId: 4242,
  });
  await expect(runMigration("0008_browser_adapter_bindings.sql"))
    .rejects.toThrow("browser_adapter_job_id_preflight_failed");
  expect(await dumpLegacySchemaAndRows()).toEqual(before);
  expect(await migrationWasRecorded("0008_browser_adapter_bindings.sql"))
    .toBe(false);
});

it("rolls back both activation rows when capability CAS fails", async () => {
  await persistStartingBinding(validBindingWithoutProcess);
  injectFailureAfterRunActivationUpdate();
  await expect(activateAdapterProcess(validBinding))
    .rejects.toMatchObject({ category: "capability_denied" });
  expect(await loadRunBinding(runId)).toMatchObject({
    state: "starting", adapterProcessId: null,
  });
  expect(await loadCapabilityBinding(runId)).toMatchObject({
    adapterProcessId: null, activatedAt: null,
  });
});

it("allows exactly one concurrent adapter activation", async () => {
  await persistStartingBinding(validBindingWithoutProcess);
  const results = await Promise.allSettled([
    activateAdapterProcess(validBinding),
    activateAdapterProcess(validBinding),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await loadRunBinding(runId)).toMatchObject({
    state: "running", adapterProcessId: validBinding.adapterProcessId,
  });
});

it("does not execute code before the same accepted binding barrier", async () => {
  const activation = deferred<void>();
  activateAdapterProcess.mockReturnValueOnce(activation.promise);
  adapter.executeCodeRun.mockImplementation(async input => {
    const acceptance = input.onAccepted(validBinding);
    markCodeRunnerAtBarrier();
    await acceptance;
    markUserSourceExecuted();
    return validCodeResult;
  });
  const execution = orchestrator.executeCode(codeInput);
  await codeRunnerReachedBarrier();
  expect(userSourceExecuted()).toBe(false);
  activation.resolve();
  await execution;
  expect(userSourceExecuted()).toBe(true);
});

it("waits for one internal CDP relay handshake before code source", async () => {
  const harness = await createAcceptedCodeAdapterHarness();
  harness.pauseInternalCdpWriterAcquisition();
  const execution = harness.execute();
  await harness.internalCdpUpgradeStarted();
  expect(harness.userSourceExecuted()).toBe(false);
  expect(harness.internalCdpOpenCount()).toBe(1);
  harness.releaseInternalCdpWriter();
  await harness.internalCdpUpgradeCompleted();
  await execution;
  expect(harness.userSourceExecuted()).toBe(true);
  expect(harness.writerHeldDuringSource()).toBe(true);
  expect(harness.writerHeldAfterTerminal()).toBe(false);
});

it("rejects code binding mismatch and restart before source execution", async () => {
  for (const mode of ["wrong_job", "wrong_supervisor", "restart"] as const) {
    const harness = await createFreshCodeAdapterHarness(mode);
    await expect(harness.execute()).rejects.toMatchObject({
      category: "capability_denied",
    });
    expect(harness.userSourceExecuted()).toBe(false);
    expect(harness.callbacksSent()).toBe(0);
    await harness.dispose();
  }
});

it("cancels accepted code and persists no late unvalidated result", async () => {
  const harness = await createAcceptedRunningCodeHarness();
  const execution = harness.execute();
  await harness.userSourceStarted();
  await orchestrator.stopSession(harness.sessionId, "requested");
  await expect(execution).rejects.toMatchObject({ category: "cancelled" });
  expect(harness.adapter.cancelExecutionRun).toHaveBeenCalledWith(
    harness.runId, "requested",
  );
  expect(harness.processTreeAlive()).toBe(false);
  expect(await harness.persistedOutput()).toBeNull();
});
```

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/db/migrate.integration.test.ts src/lib/browser-state/store.integration.test.ts src/lib/browser-state/capability-store.test.ts src/lib/browser-runtime/protocol.test.ts src/lib/browser-runtime/execution-adapter.test.ts src/lib/browser-runtime/orchestrator.test.ts
```

Expected: FAIL because adapter-binding migration, execution boundary, and
orchestrator do not exist.

- [ ] **Step 3: Migrate durable adapter authorization bindings**

Create migration `0008_browser_adapter_bindings.sql` and matching Drizzle
fields. It performs these operations in this order:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM browser_interact_actions
    WHERE adapter_job_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'browser_adapter_job_id_preflight_failed';
  END IF;
END $$;

ALTER TABLE browser_interact_actions
  ALTER COLUMN adapter_job_id TYPE uuid USING adapter_job_id::uuid;

ALTER TABLE browser_capabilities
  ALTER COLUMN adapter_process_id DROP NOT NULL;

UPDATE browser_interact_runs
SET state = 'interrupted', finished_at = COALESCE(finished_at, now()),
    error_category = COALESCE(error_category, 'adapter_binding_migration'),
    adapter_process_id = NULL
WHERE state IN ('starting', 'running');

UPDATE browser_interact_runs
SET adapter_process_id = NULL
WHERE adapter_process_id IS NOT NULL;

UPDATE browser_capabilities
SET revoked_at = COALESCE(revoked_at, now()), adapter_process_id = NULL;

ALTER TABLE browser_interact_runs
  ADD COLUMN adapter_job_id uuid,
  ADD COLUMN adapter_supervisor_id uuid;

ALTER TABLE browser_capabilities
  ADD COLUMN adapter_job_id uuid,
  ADD COLUMN adapter_supervisor_id uuid,
  ADD COLUMN activated_at timestamptz;
```

Run the preflight and every following statement in the migration runner's one
transaction. Any malformed, uppercase/noncanonical, or non-UUID legacy action
job ID raises before run interruption, capability revocation, DDL, or casts;
the transaction rolls back with zero partial migration. Do not lowercase,
coerce, delete, or quarantine legacy rows. Migration tests seed each invalid
form, require the named failure, and verify schema/data are byte-for-byte
unchanged before retry with corrected data.

The preflight must complete before any DDL or data mutation. After the valid
action cast, drop capability `adapter_process_id` `NOT NULL` before either run
or capability process values are cleared. Seed at least one otherwise valid,
populated legacy capability and prove migration succeeds, revokes it, clears
its process, and retains its policy/audit fields. A noncanonical legacy action
job ID in that same populated fixture aborts the transaction before the drop,
updates, casts, new columns, constraints, or migration record are observable.

Add exact checks: adapter process ID is null or a positive integer; run
`adapter_job_id` and `adapter_supervisor_id` are both null or both non-null;
process ID may be non-null only with both; prompt/code `running` requires all
three; prompt/code `starting` requires job+supervisor and null process;
prompt/code `queued` requires all null; non-adapter modes require all null;
terminal prompt/code rows retain either all-null never-started identity or
their immutable job+supervisor with optional accepted process. An unrevoked
capability requires job+supervisor; `activated_at` and process ID are both
null or both non-null; an unrevoked capability may redeem only when both are
non-null. Add unique partial indexes on non-null run job ID and on one
unrevoked `(run_id,adapter_job_id)` capability.

Add a `BEFORE UPDATE` trigger shared by runs/capabilities. Once job or
supervisor is non-null, changing/clearing it raises
`adapter_binding_immutable`. A run process permits exactly one null-to-value
CAS. A capability process and activation timestamp permit exactly one joint
null-to-value CAS. Changing or clearing any bound value later raises the same
error.
Revocation and terminal state do not erase identity. Migration tests prove
invalid state/null combinations, nonpositive process, duplicate active job,
and every post-bind mutation fail; valid pending, activated, terminal, and
legacy-revoked rows pass. The migration intentionally interrupts unfinished
legacy work, clears unauthenticatable legacy run process IDs, and revokes/
clears every pre-binding capability process before constraints land; it keeps
terminal action audit rows.

- [ ] **Step 4: Define exact prompt/code adapter types**

In `browser-state/types.ts`, define `ObservationV1.result` through a type-only
re-export of the API-owned Task 7 schema inference:

```ts
import type { BrowserOperationResultV1 } from
  "../scrape-interact/browser-service-contracts";
export type { BrowserOperationResultV1 };
```

Use this type for durable action rows, service results, and observations; do
not add another result shape.

Define the authorization identity once:

```ts
export type AdapterAuthorizationBinding = {
  adapterJobId: string;        // canonical UUID
  adapterSupervisorId: string; // canonical UUID, API-generated per job
  adapterProcessId: number;    // positive OS PID accepted by adapter
};

export type AdapterPendingBinding = Omit<
  AdapterAuthorizationBinding,
  "adapterProcessId"
> & { adapterProcessId: null };

export type AdapterPendingAuthorizationInput = {
  adapterJobId: string;
  adapterSupervisorId: string;
  onAccepted(binding: AdapterAuthorizationBinding): Promise<void>;
};
```

Every runtime schema uses `canonicalUuidSchema` for job/supervisor IDs and a
positive integer schema for process ID. Both prompt and code inputs extend the
same pending authorization input. The adapter must await `onAccepted()`
successfully before launching Codex, executing user code, opening its relay,
or sending any callback.

```ts
import { z } from "zod";
import type {
  BrowserOperation,
  BrowserOperationResultV1,
} from "../browser-state/types";
import {
  canonicalUuidSchema,
  httpUrlSchema,
} from "../scrape-interact/browser-service-contracts";

const internalRefSchema = z.string().min(1).max(128);
const internalTextSchema = z.string().max(20_000);
const internalJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(internalJsonValueSchema),
  z.record(z.string(), internalJsonValueSchema),
]));

export const browserOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("click"), ref: internalRefSchema }),
  z.strictObject({
    kind: z.literal("fill"), ref: internalRefSchema,
    value: internalTextSchema,
  }),
  z.strictObject({
    kind: z.literal("type"), ref: internalRefSchema,
    value: internalTextSchema,
    delayMs: z.number().int().min(0).max(250),
  }),
  z.strictObject({
    kind: z.literal("press"), ref: internalRefSchema,
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("select"), ref: internalRefSchema,
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
  z.strictObject({
    kind: z.literal("get_text"), ref: internalRefSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("get_url") }),
  z.strictObject({
    kind: z.literal("navigate"), url: httpUrlSchema,
  }),
  z.strictObject({
    kind: z.literal("evaluate"), expression: internalTextSchema,
    args: z.record(z.string(), internalJsonValueSchema),
  }),
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
  z.strictObject({
    version: z.literal(1),
    type: z.literal("action"),
    action: browserOperationSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("final"),
    output: z.string().max(256 * 1024),
  }),
]);

const modelWireRefSchema = z.string().min(1).max(128);
const modelWireTextSchema = z.string().max(20_000);
const emptyModelWireArgsSchema = z.strictObject({})
  .transform((): Record<string, never> => ({}));

export const modelWireBrowserOperationV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("click"), ref: modelWireRefSchema }),
  z.strictObject({
    kind: z.literal("fill"),
    ref: modelWireRefSchema,
    value: modelWireTextSchema,
  }),
  z.strictObject({
    kind: z.literal("type"),
    ref: modelWireRefSchema,
    value: modelWireTextSchema,
    delayMs: z.number().int().min(0).max(250),
  }),
  z.strictObject({
    kind: z.literal("press"),
    ref: modelWireRefSchema,
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("select"),
    ref: modelWireRefSchema,
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
  z.strictObject({
    kind: z.literal("get_text"),
    ref: modelWireRefSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("get_url") }),
  z.strictObject({
    kind: z.literal("navigate"),
    url: httpUrlSchema,
  }),
  z.strictObject({
    kind: z.literal("evaluate"),
    expression: modelWireTextSchema,
    args: emptyModelWireArgsSchema,
  }),
]);

export const modelWireDecisionV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("action"),
    action: modelWireBrowserOperationV1Schema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("final"),
    output: z.string().max(256 * 1024),
  }),
]);

export const modelDecisionEnvelopeV1Schema = z.strictObject({
  decision: modelWireDecisionV1Schema,
});

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

export type PromptRunInput = AdapterPendingAuthorizationInput & {
  runId: string;
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

export type CodeRunInput = AdapterPendingAuthorizationInput & {
  runId: string;
  language: "node" | "python" | "bash";
  source: string;
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

const boundedCodeTextSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
    context.addIssue({ code: "custom", message: "code output exceeds bound" });
  }
});

export const codeRunResultSchema = z.strictObject({
  stdout: boundedCodeTextSchema,
  result: boundedCodeTextSchema,
  stderr: boundedCodeTextSchema,
  exitCode: z.number().int().min(0).max(255),
  killed: z.boolean(),
}).superRefine((value, context) => {
  const total = Buffer.byteLength(value.stdout, "utf8") +
    Buffer.byteLength(value.result, "utf8") +
    Buffer.byteLength(value.stderr, "utf8");
  if (total > 512 * 1024) {
    context.addIssue({ code: "custom", message: "code result exceeds bound" });
  }
});

export type CodeRunResult = z.infer<typeof codeRunResultSchema>;
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
All run/action/job/supervisor identifiers in protocol, adapter request,
accepted event, and callback schemas use `canonicalUuidSchema`; all page,
initial, final, and navigate URLs use `httpUrlSchema`. Add protocol cases for
uppercase UUID and `file:`, `mailto:`, and `ftp:` URLs in every affected union.
`normalizeModelDecisionEnvelopeV1` validates wire input first, maps a null text
ref to internal omission, retains empty evaluate args as `{}`, and returns
unchanged internal `ModelDecisionV1`. Envelope/schema/semantic mismatches map
to `model_protocol_error`. `protocol.test.ts` locks every wire variant, both
normalization special cases, all rejections, and proves internal evaluate args
remain available to trusted API/Browser Service callers. Prompt and code inputs
share the new pending authorization fields; their remaining fields,
`PromptRunResult`, action callbacks, ledger rows, and observations retain their
existing shapes. Every action result uses the strict bounded
`BrowserOperationResultV1` from Locked private contracts. Protocol tests
reject wrong kind/result pairs, cyclic/unsupported JSON-safe values, every
bound overflow, and encoded observations over 64 KiB.

Beyond the shared server-generated authorization fields, keep `CodeRunInput`
restricted to run ID, language, source, deadline, and correlation ID. Source
is at most 100,000 characters and deadline at most 300 seconds. The public
request cannot set adapter binding, model, effort, policy/schema versions,
callback URL, endpoint, token, command, mount, environment, or network.
Validate every code return with `codeRunResultSchema`; reject unknown fields,
per-field output over 256 KiB, aggregate text over 512 KiB, and invalid exit
status before persistence. Cancellation aborts the adapter call, kills its
process tree, waits for terminal `killed: true`, revokes capability, and
persists no unvalidated output. The unavailable adapter throws typed 503
categories.

- [ ] **Step 5: Implement durable adapter binding, session create, and stop**

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

Prompt/code run creation stores all adapter fields null in `queued`. Before
calling the host adapter, generate canonical job and supervisor UUIDs. Under
one mutation lease and database transaction, CAS the same run
`queued -> starting`, persist job+supervisor with null process, and issue one
pending capability containing the identical pair, null process, and null
activation. Commit before `executePromptRun` or `executeCodeRun`; a failed CAS
dispatches nothing.
Browser-operation/replay runs never receive adapter fields.

Pass job+supervisor to the prompt or code adapter call. Its async `onAccepted`
callback requires the adapter to echo both plus a positive process ID. Under
one short mutation lease and one database transaction, lock the exact run and
capability. Issue one run `UPDATE` that atomically CASes
`state='starting', adapter_process_id IS NULL` to
`state='running', adapter_process_id=<pid>` while matching run/job/supervisor.
In the same transaction, CAS the exact unrevoked pending capability from null
process/activation to the same process ID/current activation timestamp. Each
statement must affect exactly one row; any mismatch, injected error, or
concurrent loser rolls back both writes and exposes no intermediate invalid
row. Wrong job,
supervisor, state, process reuse, revoked/expired capability, or zero affected
rows returns `capability_denied`, cancels adapter job, revokes capability, and
terminates run/session. The adapter awaits callback success before any model,
code, or callback work, closing the first-callback race.

After successful code activation, the adapter opens exactly one authenticated
`/internal/browser-runs/:runId/cdp` WebSocket with the persisted job,
supervisor, and process headers. It treats successful HTTP 101 only after
Browser Service writer acquisition as `relay_ready`; user source cannot start
before that barrier. Prompt mode never opens this relay. Busy, failed, stale-
binding, gate-close, cancellation, or deadline handshake closes/revokes the
relay and executes zero source. Close the code relay and wait for Browser
Service writer release before accepting terminal code result or reporting
cancellation.

Callback authorization loads run and one active capability by run ID and
requires exact persisted job/supervisor/process equality before reading or
preparing any action. On API/adapter restart,
`interruptUnfinishedBrowserWork()` interrupts queued, starting, and running
work and revokes pending/active capabilities without clearing bindings. A
later acceptance or callback from the old process cannot reactivate them.

Create `capability-store.ts` in this task with gate-leased pending issue,
joint activation CAS, exact binding lookup, revoke, expiry, and startup
recovery methods needed above. It stores only token hash and never exposes raw
token after issuance. Task 10 extends this same required store with action
policy redemption/accounting; it does not create a second capability owner.

Prompt and code execution use short leases for run/capability creation and the
binding/activation transitions, then releases every lease before obtaining
initial observation when needed and calling the matching adapter method once.
Never hold a mutation lease across the up-to-300-second host job. Action
callbacks take their own Task 10 leases. After host return, acquire fresh
leases for validated output, usage/count persistence, capability revocation,
and terminal run/session transitions. Validate prompt output
<=256 KiB, `turnCount <= 26`, `actionCount <= 25`, zero tool/approval counts,
and counts equal durable action ledger totals before success. Validate code
through exact `codeRunResultSchema` before storing its existing response
fields. Revoke capability in `finally`. Persist sanitized usage/counts and
terminal state.

Stop uses one short lease to claim cleanup owner, releases it while cancelling
adapter, then uses bounded leases for capability/grant revocation, Browser
Service close plus prepared-generation capture, profile finalize/pointer CAS,
and terminal result. A failed generation
database commit leaves prior pointer authoritative and discards that exact
orphan best-effort. Service failure still leaves durable terminal state.

- [ ] **Step 6: Run migration and orchestration tests**

```bash
pnpm --dir apps/api exec vitest run --no-file-parallelism src/db/migrate.integration.test.ts src/lib/browser-state/store.integration.test.ts src/lib/browser-state/capability-store.test.ts src/lib/browser-runtime/protocol.test.ts src/lib/browser-runtime/execution-adapter.test.ts src/lib/browser-runtime/orchestrator.test.ts
```

Expected: PASS for populated legacy migration, null/immutability constraints,
durable pending and active binding, atomic activation rollback and concurrent
winner, wrong-job first callback, wrong supervisor/process, stale capability
after restart, prompt/code acceptance barriers, bounded code results,
cancellation, correct persisted binding, create rollback, profile lock, replay
failure, one outer prompt call, exact loop policy, count verification,
duplicate stop, execution/stop/reconciliation races, mutation drain, no
host-held lease, profile crash boundaries, and unavailable adapters.

- [ ] **Step 7: Commit orchestration boundary**

```bash
git add apps/api/src/db/migrations/0008_browser_adapter_bindings.sql apps/api/src/db/schema/public.ts apps/api/src/db/migrate.integration.test.ts apps/api/src/lib/browser-runtime/protocol.ts apps/api/src/lib/browser-runtime/protocol.test.ts apps/api/src/lib/browser-runtime/execution-adapter.ts apps/api/src/lib/browser-runtime/execution-adapter.test.ts apps/api/src/lib/browser-runtime/orchestrator.ts apps/api/src/lib/browser-runtime/orchestrator.test.ts apps/api/src/lib/browser-state/types.ts apps/api/src/lib/browser-state/store.ts apps/api/src/lib/browser-state/store.integration.test.ts apps/api/src/lib/browser-state/capability-store.ts apps/api/src/lib/browser-state/capability-store.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: bind local browser adapter runs" -m "Persist immutable adapter job, supervisor, process, and capability
identity before any host callback or model execution.

Create and stop durable browser sessions around one bounded host job and
verify adapter counts against durable state."
```

### Task 10: Add durable host action callback and execute-once coordinator

**Files:**
- Create: `apps/api/src/lib/browser-runtime/action-normalization.ts`
- Create: `apps/api/src/lib/browser-runtime/action-normalization.test.ts`
- Create: `apps/api/src/lib/browser-runtime/action-coordinator.ts`
- Create: `apps/api/src/lib/browser-runtime/action-coordinator.test.ts`
- Modify: `apps/api/src/lib/browser-state/capability-store.ts`
- Modify: `apps/api/src/lib/browser-state/capability-store.test.ts`
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

it("authenticates persisted adapter binding before first action", async () => {
  for (const headers of [wrongJobHeaders, wrongSupervisorHeaders,
    wrongProcessHeaders, staleRestartHeaders]) {
    const response = await postAdapterAction(proposal, headers);
    expect(response.status).toBe(403);
    expect(await actionCount(activeRun.id)).toBe(0);
  }
  const accepted = await postAdapterAction(proposal, exactPersistedHeaders);
  expect(accepted.status).toBe(200);
  expect(await actionCount(activeRun.id)).toBe(1);
});

it("holds a short mutation lease through internal CDP relay setup", async () => {
  pauseBrowserServiceWriterAcquisition();
  const relay = openInternalCodeCdp(exactPersistedHeaders);
  await privateRelayGrantCreated();
  const drain = startupGate.close("service_restart");
  expect(await promiseState(drain.drained)).toBe("pending");
  releaseBrowserServiceWriterAcquisition();
  const socket = await relay;
  await expect(drain.drained).resolves.toBeUndefined();
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(browserServiceWriterHeld(runId)).toBe(true);
  socket.close();
  await expect(browserServiceWriterReleased(runId)).resolves.toBeUndefined();
});

it.each(["busy", "stale_binding", "gate_closed", "connect_failed"])(
  "runs no code and revokes the relay grant when CDP setup is %s",
  async failure => {
    configureInternalCodeCdpFailure(failure);
    await expect(executeCodeRun(validCodeInput)).rejects.toMatchObject({
      category: expect.stringMatching(
        /browser_state_unavailable|browser_unavailable|capability_denied/,
      ),
    });
    expect(codeSourceLaunchCount()).toBe(0);
    expect(await activePrivateRelayGrantCount(runId)).toBe(0);
    expect(browserServiceWriterHeld(runId)).toBe(false);
  },
);
```

Add tests for `prepared -> rejected_no_effect`, Browser Service proven
`failed_no_effect`, pre-dispatch cancellation, same sequence/different hash,
same action ID/different hash, duplicate side-effect hash after definite
failure, repeated read-only hash, action 26, expired capability, owner/session/
run/job/process mismatch, callback cancellation, wrong result discriminant,
omitted result, raw invalid/non-finite JSON, 40,000-character `get_text`,
32 KiB evaluate, 64 KiB result, 128 KiB service response, and 64 KiB
observation boundaries. For every overflow/serialization failure after
dispatch, assert `outcome_unknown`, no result cache, capability revocation,
and terminal run/session. Each rejected adapter-binding case performs no
action insert, capability redemption, Browser Service call, or public-state
change.

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --dir apps/api exec vitest run src/lib/browser-runtime/action-normalization.test.ts src/lib/browser-runtime/action-coordinator.test.ts src/lib/browser-state/capability-store.test.ts src/controllers/internal/browser-runs.test.ts
```

Expected: FAIL because normalization, coordinator, capability policy
redemption, and callback route do not exist.

- [ ] **Step 3: Implement canonical hash and trusted effect classification**

Serialize operation with recursively sorted object keys, exact JSON string/
number/boolean/null values, and no undefined/non-JSON values. Hash UTF-8 bytes
with SHA-256. Classify `snapshot`, `get_text`, `get_url`, and `wait` as
`read_only`; classify click, fill, type, press, select, scroll, navigate, and
evaluate as `side_effecting`. API recomputes both values and rejects an adapter
mismatch as `model_protocol_error`.

Use the prerequisite `SubmitBrowserActionV1` type and define an exact strict
Zod schema for it. Do not introduce a renamed callback type.

`adapterJobId` and `actionId` use the API's shared
`canonicalUuidSchema`, `sequence` is 1..25, and
`proposalHash` is lowercase SHA-256. The API recomputes the normalized hash
and sends it to Browser Service as `normalizedProposalHash`. The callback body
accepts no owner, session, capability, model, endpoint, URL grant, command,
path, environment, mount, or idempotency override.

- [ ] **Step 4: Add actions and extend capability policy helpers**

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
deadlines, and timestamps. It issues pending with null process/activation,
activates once through Task 9's joint run/capability CAS, and redeems only an
exact activated job/supervisor/process binding. Redemption never returns a raw
token and is available only to the coordinator.

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
server-held run authority. Require canonical
`x-firecrawl-adapter-job-id`, `x-firecrawl-adapter-supervisor-id`, and positive
integer `x-firecrawl-adapter-process-id` headers. Before parsing/proposing an
action, load the run plus one unrevoked, unexpired, activated capability and
require all three headers, body `adapterJobId`, run binding, and capability
binding match exactly. Missing, malformed, uppercase, pending, stale,
revoked, or mismatched identity maps to sanitized `capability_denied` and
performs no action write. Apply the same persisted binding check before CDP
upgrade or artifact ingestion. The action endpoint then parses
`SubmitBrowserActionV1`, invokes the coordinator, and returns only strict
`ObservationV1` with 64 KiB total and 40,000-character excerpt limits. This is
an authenticated host action callback, not an MCP or Codex browser relay.

For the internal code CDP route, hold one short API mutation lease while
redeeming the capability, creating the private Browser Service relay grant,
and awaiting the upstream HTTP 101. Browser Service acquires the session
writer before returning 101, so that response is the adapter's `relay_ready`
barrier. Recheck the gate immediately before opening upstream. On gate close,
binding failure, busy writer, cancellation, deadline, or connect failure,
revoke the private grant before releasing the lease and execute no code.
Release the API lease immediately after successful handshake; relay frames do
not hold it. Keep the Browser Service writer for the socket lifetime, then
close the downstream relay and await writer release before accepting terminal
code output.

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
caching, unknown outcome termination, recovery, internal code relay readiness,
grant revocation, writer release, and redaction.

- [ ] **Step 8: Commit action coordinator**

```bash
git add apps/api/src/lib/browser-runtime/action-normalization.ts apps/api/src/lib/browser-runtime/action-normalization.test.ts apps/api/src/lib/browser-runtime/action-coordinator.ts apps/api/src/lib/browser-runtime/action-coordinator.test.ts apps/api/src/lib/browser-state/capability-store.ts apps/api/src/lib/browser-state/capability-store.test.ts apps/api/src/controllers/internal/browser-runs.ts apps/api/src/controllers/internal/browser-runs.test.ts apps/api/src/routes/internal.ts apps/api/src/index.ts apps/api/src/lib/browser-state/store.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: coordinate browser actions durably" -m "Persist every model action before dispatch and authorize it through
exact durable adapter and capability identity. Execute each action at
most once.

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
- Modify: `apps/api/src/controllers/v2/types.ts`
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
Because the browser controller imports shared `controllers/v2/types.ts`, that
file enters browser import closure. Mechanically replace its remaining legacy
closed-object `.strict()` calls with equivalent Zod 4 `z.strictObject()`
declarations without changing fields, refinements, defaults, or public
behavior; controller compatibility tests cover the imported schemas.

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

Code path creates the same durable pending job/supervisor capability, passes
the common server-generated authorization input to `executeCodeRun`, and
requires its awaited acceptance before source or relay work. Validate the
strict bounded `CodeRunResult`, then keep existing output/stdout/result/stderr/
exit fields through the same adapter abstraction. Wrong or stale acceptance
executes no source and persists no output. Stop aborts the adapter, waits for
the killed code process tree, revokes authority and proxy URLs, closes
browser/profile, persists one terminal state, and is idempotent. Remove local
Gemini/cloud fallback; preserve hosted behavior only when the local feature is
disabled.

- [ ] **Step 5: Run public controller tests**

```bash
pnpm --dir apps/api exec vitest run src/controllers/v2/browser.test.ts src/controllers/v2/scrape-browser.test.ts
```

Expected: PASS for direct compatibility, prompt/code response fields, one
outer adapter job, code acceptance-before-source, strict code result bounds,
code cancellation, action/turn accounting, replay, domains, profile locking,
typed failures, no local provider fallback, and terminal stop.

- [ ] **Step 6: Commit controller integration**

```bash
git add apps/api/src/controllers/v2/types.ts apps/api/src/controllers/v2/browser.ts apps/api/src/controllers/v2/browser.test.ts apps/api/src/controllers/v2/scrape-browser.ts apps/api/src/controllers/v2/scrape-browser.test.ts apps/api/src/lib/scrape-interact/browser-agent.ts
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

it("does not open upstream when gate closes after private grant", async () => {
  pauseAfterPrivateGrantCreation();
  const relay = openProxy(passiveToken, "passive");
  await privateGrantCreated();
  const drain = startupGate.close("service_restart");
  expect(await promiseState(drain.drained)).toBe("pending");
  releasePrivateGrantPause();
  await expect(relay).rejects.toMatchObject({ code: 1013 });
  expect(browserClient.openStream).not.toHaveBeenCalled();
  expect(browserClient.revokeRelayGrant).toHaveBeenCalledTimes(1);
  await drain.drained;
});

it("releases startup lease after handshake, not stream lifetime", async () => {
  pauseOpenStreamHandshake();
  const relay = openProxy(passiveToken, "passive");
  await openStreamHandshakeStarted();
  const drain = startupGate.close("service_restart");
  expect(await promiseState(drain.drained)).toBe("pending");
  completeOpenStreamHandshake();
  const socket = await relay;
  await drain.drained;
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.close();
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
private relay-grant creation plus successful
`browserClient.openStream()` handshake share one bounded mutation lease.
Immediately before starting the handshake, call `startupGate.assertOpen()`
again while still holding that lease. If the gate closed after grant creation,
revoke the exact private grant inside the lease, close WebSocket 1013, and make
no upstream connection. If connect fails, synchronously revoke the exact
private grant before releasing the lease. Release the startup mutation lease
immediately after successful handshake and before relaying the first frame;
never hold it for the stream lifetime. If gate closes before lease acquisition,
close WebSocket 1013 and make no Browser Service call. Cap messages
at 64 KiB; apply backpressure and bidirectional close/cancellation. Require
configured API Origin for view streams; CDP may omit Origin but needs CDP
grant. Never log tokens, private URLs, CDP payloads, or page input.

- [ ] **Step 4: Run proxy tests**

```bash
pnpm --dir apps/api exec vitest run src/controllers/v2/browser-proxy.test.ts
```

Expected: PASS for permission separation, expiry, replay, owner binding,
stop revocation, pre/post-grant gate-close races, handshake failure revocation,
lease release before stream lifetime, CSRF/origin, bounds, backpressure, and
disconnect cleanup.

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
- Modify: `scripts/local-firecrawl`
- Create: `scripts/local-firecrawl.test.mjs`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/harness.ts`
- Create: `apps/api/src/harness-browser-service.ts`
- Create: `apps/api/src/harness-browser-service.test.ts`

- [ ] **Step 1: Write harness lifecycle tests**

Prove the harness builds `firecrawl-local-browser-service:harness`, starts one
fresh uniquely named owned container per invocation with a generated service
key, service-generated process nonce, temporary canonical state-root bind,
disposable API database,
and unique Compose/container project identity. Expose only a harness-owned
allocated loopback port, wait for authenticated liveness, pass exact API
environment before API spawn, wait for API-confirmed matching readiness after
API reconciliation, and remove container/root/database on success, failure,
or signal. Never reuse or attach to a pre-existing Browser Service, API
database, state root, container, or port.

```ts
it("registers cleanup before creating any owned resource", async () => {
  liveness.reject(new Error("not live"));
  await expect(startHarnessBrowserService(deps)).rejects.toThrow("not live");
  expect(events).toEqual([
    "validate-env", "detect-runtime", "build", "precompute-identities",
    "register-cleanup", "create-root", "create-database", "run-container",
    "live", "remove-container", "drop-database", "remove-root",
    "unregister-cleanup",
  ]);
});

it("rejects every external Browser Service override", async () => {
  for (const name of [
    "TEST_BROWSER_SERVICE_URL",
    "TEST_BROWSER_SERVICE_API_KEY",
    "BROWSER_SERVICE_URL",
    "BROWSER_SERVICE_API_KEY",
    "LOCAL_BROWSER_STATE_ROOT",
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

it("uses a fresh owned root and API database each run", async () => {
  const first = await startAndStopHarness();
  const second = await startAndStopHarness();
  expect(second.containerName).not.toBe(first.containerName);
  expect(second.stateRoot).not.toBe(first.stateRoot);
  expect(second.databaseName).not.toBe(first.databaseName);
  expect(second.processNonce).not.toBe(first.processNonce);
  expect(first.cleaned).toEqual({ container: true, root: true, database: true });
});

test.each([
  "after-register", "after-root", "after-database",
  "during-container-run", "after-container-run",
])("signal cleanup is idempotent at %s", async boundary => {
  const run = startHarnessPausedAt(boundary);
  await run.reachedBoundary;
  await run.signal("SIGTERM");
  await run.cleanupAgain();
  expect(run.cleanupEvents).toEqual([
    ...(run.containerMayExist ? ["remove-container"] : []),
    ...(run.databaseCreated ? ["drop-database"] : []),
    ...(run.rootCreated ? ["remove-root"] : []),
  ]);
  expect(run.unmanagedResourcesTouched).toEqual([]);
});
```

`scripts/local-firecrawl.test.mjs` runs the wrapper with a fake `docker`
executable and records argument arrays. Assert normal `start` order is exactly:

```text
compose up dependencies including browser-service
compose up --no-deps minio-init and verify exited 0
compose up --no-deps api and wait for API readiness
final health/port verification
```

The trace contains no `app-db-migrate` invocation. Pause API readiness and
prove the wrapper remains blocked there until readiness. Make API exit with
the typed post-handoff migration failure and prove wrapper returns nonzero.
Parse default rendered Compose JSON and assert API has no dependency on
`app-db-migrate`, that sidecar has an explicit nondefault maintenance profile,
and default service selection cannot auto-start it. `minio-init` remains the
required bucket bootstrap and completes before API starts. Explicitly targeting
the profiled migration sidecar remains available for operator maintenance.

Add successful order assertion:

```ts
expect(events).toEqual([
  "browser:start",
  "browser:live",
  "api:start",
  "api-process:control-handoff",
  "api-process:migrations",
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
expect(harnessParent.runApplicationMigrations).not.toHaveBeenCalled();
expect(apiChild.runApplicationMigrations).toHaveBeenCalledTimes(1);
```

Add an API-only restart case after creating one replay checkpoint, committing
one profile generation, and opening session/context/grant/writer/stream
fixtures. Keep the Browser Service container running and assert its
`processNonce` is unchanged. The restarted API must complete a fresh control
handoff before migrations/recovery, receive a different generation, observe a
changed durable snapshot digest, reconcile successfully, and reach ready.
Every old service runtime resource is closed before handoff response and one
request from the retained old API fixture receives
`control_generation_mismatch` with no effect.

Add a blocked-reconciliation case and assert operational/artifact retention
started once but no `api-process:browser-retention:start` event. Restart
Browser Service once and assert one API-process recovery/reconciliation
sequence, not one from harness parent plus one from API. These event assertions
come from test-only API lifecycle notifications; harness never invokes those
functions.

- [ ] **Step 2: Run test and verify red**

```bash
pnpm --dir apps/api exec vitest run src/harness-browser-service.test.ts
node --test scripts/local-firecrawl.test.mjs
```

Expected: FAIL because lifecycle helper does not exist.

- [ ] **Step 3: Add private Compose service**

Build `apps/browser-service`, run on backend network with no published port,
2 CPUs, 4 GiB memory/no swap, 1 GiB noexec/nosuid tmpfs, and shared
`browser-state:/var/lib/firecrawl-browser`. Healthcheck authenticated live
state only; API coordinator establishes ready state. Mount the same volume at
the same `LOCAL_BROWSER_STATE_ROOT` for API and Browser Service, and pass
private URL/key plus reconciliation limits to API. `replay/`, `profiles/`, and
`quarantine/` are direct children of that root; neither process accepts a
different root from a request or inserts an intermediate layer. Keep
`LOCAL_BROWSER_SERVICE_ENABLED=false` in both Compose and
`.env.example.local`. Never mount Docker
socket or adapter token in this task.
Remove the API service's pre-start dependency on `app-db-migrate` in the
rendered local Compose topology. PostgreSQL health may gate process launch,
but only API process may invoke application migrations, after its successful
Browser Service control handoff. Keep migration sidecars available for other
explicit workflows without making local API startup depend on one. Put
`app-db-migrate` behind an explicit nondefault maintenance profile so plain
`docker compose up` cannot auto-start it. Preserve `minio-init` as the required
bucket bootstrap before API process launch. API may depend on long-running
PostgreSQL, MinIO, queues, and Browser Service health only; wrapper owns the
one-shot ordering rather than an API `depends_on` edge.

- [ ] **Step 4: Implement exact harness lifecycle**

Use argument arrays and existing container-runtime detection. Start Browser
Service only for exact `pnpm test:snips:local-browser`. Before any build/run,
reject the override variables
listed in Step 1 when inherited from caller environment; the harness creates
and overwrites none of them from external input. Generate cryptographically
random invocation ID and service key. Precompute random collision-resistant
root path, application-database/container name, Browser
Service container name, network/project identity, and loopback port before
creating any resource. Register one idempotent cleanup object plus SIGINT,
SIGTERM, `beforeExit`, startup-error, and final synchronous `exit` fallback
handlers immediately after precomputation and before root/database/container
creation. Signal/startup paths await normal cleanup; the exit fallback uses
only precomputed argument arrays and synchronous force-remove/drop/remove for
any still-marked resource.

Cleanup owns explicit creation-state flags and always runs reverse creation
order: remove the precomputed Browser Service container name with idempotent
force-remove (covering a runtime that created it before returning failure),
drop/remove the exact disposable application database/container, then remove
the exact root and its precomputed sibling ownership marker. A second cleanup
call is a no-op. Unregister handlers only
after cleanup settles. It never glob-matches names, follows symlinks, removes
an unmarked path, drops an externally named database, or touches a resource
whose invocation ownership token differs.

After registration, atomically create the empty mode-0700 root at the
precomputed path and a sibling ownership marker under the harness temp parent;
the marker is never mounted inside the canonical root. Then create a fresh
PostgreSQL instance and database under the precomputed identity, then run
Browser Service. Fail if root/database/container already exists, root resolves
outside harness temp parent, root has unexpected entries, or any ownership
marker mismatches.
Container name, network/project identity, loopback port, bind source, API
database URL, and canonical root all derive from this invocation.
Reconciliation is allowed only against this owned root; never accept an
arbitrary path, append another root component, or clean an unmanaged root.

Browser Service alone generates its 32-byte process nonce. Harness reads it
from authenticated live health, requires canonical 43-character base64url,
requires it differs from every prior process in that invocation, and passes no
nonce override. Harness never creates, passes, reads from discovery, or adopts
a control-generation nonce. Each API process generates its own API instance
identity/idempotency key and obtains its generation through the authenticated
handoff. API reconciliation must bind both returned service nonces.

Return live handle and generated environment to harness, spawn API, then wait
for authenticated ready whose process/generation/digest equal coordinator's
binding.
Remove existing harness-parent imports/calls that run
`runApplicationMigrations`, `interruptUnfinishedBrowserWork`,
cleanup-intent recovery, or
`createLocalRetentionService`; API `index.ts` is sole operational, artifact,
browser-state retention, and migration-order owner. Harness may create and
health-check disposable PostgreSQL but cannot migrate it. Never wait ready
before API spawn and never start any retention from harness. On cleanup,
signal API and wait while its
coordinator stops monitor and its one retention service, remove Browser
Service, drop disposable PostgreSQL, then remove owned root. Configure API and
service with the same generated direct-root mapping. Missing Docker or Podman
uses existing missing-runtime error; do not install or start an unmanaged
process.

Modify `scripts/local-firecrawl` normal startup to start long-running
dependencies plus private Browser Service first, run and verify the required
`minio-init` bucket bootstrap, then start API with `--no-deps --wait`. API itself
performs control handoff, migrations, durable fence activation, recovery,
snapshot, reconciliation, and readiness in that order. After API health reports
ready, perform final deep/port health. Never invoke `app-db-migrate` from normal
start/restart. Retain it only as an explicit profiled maintenance service; API
is sole normal migration owner.

- [ ] **Step 5: Run harness and Compose checks**

```bash
node --test scripts/local-firecrawl.test.mjs
pnpm --dir apps/api exec vitest run --no-file-parallelism src/harness-browser-service.test.ts src/lib/browser-runtime/reconciliation-coordinator.test.ts
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --quiet
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --format json
docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml build browser-service api
```

Expected: lifecycle tests PASS in
live/API-handoff/migrations/recovery/reconcile/ready order, including API-only
restart fencing. Compose
config exits 0, image builds from committed digest, Browser Service has no
`ports`, feature remains false, only API publishes `127.0.0.1:3002`, override
environment is rejected, rendered API has no `app-db-migrate` dependency,
default Compose cannot start the profiled migration sidecar, wrapper trace
starts Browser Service, completes MinIO bucket bootstrap, then starts API for
handoff/migrations/readiness and never invokes migration sidecar, and harness
parent migration spy remains zero
while child API owns one migration event after handoff,
two invocations share no identity/state/database,
cleanup is registered before creation, injected failure/signal at every
creation boundary cleans in reverse order exactly once, partial container run
is removed, and cleanup removes only owned resources.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add compose.local.yaml .env.example.local scripts/local-firecrawl scripts/local-firecrawl.test.mjs apps/api/package.json apps/api/src/harness.ts apps/api/src/harness-browser-service.ts apps/api/src/harness-browser-service.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: add private browser service runtime" -m "Start Browser Service before API-owned migrations and keep migration
sidecar outside the default Compose lifecycle.

Pre-register reverse cleanup for fresh harness containers, state roots,
application databases, and initialize MinIO before API process startup."
```

### Task 15: Add Browser, Interact, and real-Codex smoke contracts

**Files:**
- Modify: `apps/api/src/__tests__/snips/v2/lib.ts`
- Create: `apps/api/src/__tests__/snips/v2/browser-local.test.ts`
- Modify: `apps/api/src/__tests__/snips/v2/scrape-browser.test.ts`
- Create: `apps/api/src/__tests__/snips/v2/browser-real-codex.test.ts`
- Create: `apps/api/src/cli/browser-stale-contract-scan.ts`
- Create: `apps/api/src/cli/browser-stale-contract-scan.test.ts`
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

Skip unless `RUN_REAL_CODEX_BROWSER_SMOKE=1` and the dedicated harness has
injected its invocation token and restart-control credentials. Use a controlled
fixture whose prompt requires at least one side-effecting typed action and exact
final text.
After success, query the test database by returned run/session IDs and assert:

```ts
expect(run.model).toBe("gpt-5.6-terra");
expect(run.reasoningEffort).toBe("medium");
expect(run.toolEventCount).toBe(0);
expect(run.approvalEventCount).toBe(0);
expect(run.actionCount).toBe(actions.length);
expect(run.turnCount).toBe(actions.length + 1);
expect(run.adapterJobId).toMatch(CANONICAL_UUID);
expect(run.adapterSupervisorId).toMatch(CANONICAL_UUID);
expect(run.adapterProcessId).toBeGreaterThan(0);
expect(capability).toMatchObject({
  adapterJobId: run.adapterJobId,
  adapterSupervisorId: run.adapterSupervisorId,
  adapterProcessId: run.adapterProcessId,
});
expect(actions.every(action => action.adapterJobId === run.adapterJobId))
  .toBe(true);
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
and assert no live capability, proxy grant, writer lease, adapter OS process,
or browser runtime; durable run binding remains unchanged for audit.

Before the first valid callback in the controlled adapter fixture, send wrong
job, supervisor, and process headers separately. Each returns 403 with zero
action rows/effects. Restart the adapter, replay the old exact headers, and
require stale capability denial; the new job's persisted triple succeeds.

Run a second controlled code fixture that reads a known DOM marker through the
internal CDP relay and prints one exact result. Assert one internal CDP open,
zero source execution before adapter acceptance and `relay_ready`, one Browser
Service writer for the source lifetime, and writer release after success and
cancellation. Wrong or stale binding headers, busy writer, gate close, and
connect failure must create no source process and leave no active relay grant.

The host-execution plan must run:

Start the installed host adapter and its authenticated test-control fixture
first. The fixture must listen on an exact `http://127.0.0.1:<port>` origin and
issue a canonical 32-byte base64url bearer token. Pass that same origin and
token to the smoke:

```bash
REAL_CODEX_BROWSER_TEST_ADAPTER_URL=http://127.0.0.1:<port> \
REAL_CODEX_BROWSER_TEST_ADAPTER_TOKEN=<32-byte-base64url-token> \
RUN_REAL_CODEX_BROWSER_SMOKE=1 \
pnpm --dir apps/api harness pnpm test:snips:real-codex-browser
```

The dedicated package script is part of the security boundary: it provisions
an isolated Browser Service and application database before importing the smoke
suite. Direct `vitest` execution, or any command other than the dedicated
harness script, intentionally skips the smoke even when
`RUN_REAL_CODEX_BROWSER_SMOKE=1`.

Expected after host adapter installation: PASS with one active installed Codex
process under rolling capability gate,
durable contiguous action ledger, no duplicate effects, zero tool/approval
events, exact final output, and complete cleanup.

- [ ] **Step 4: Add checked stale-contract scanner and mutation fixtures**

Add `check:browser-stale-contracts` as
`tsx src/cli/browser-stale-contract-scan.ts`. A checked discovery/import
closure, not a hand-maintained file list, defines the production scan set.
Export pure `discoverBrowserContractSources(workspaceRoot)`,
`resolveLocalImportClosure(entryPaths, workspaceRoot)`, and
`scanSources([{path,text}])`; the CLI unions discovery plus closure and refuses
to rule-scan an incomplete inventory.

```ts
export const browserContractDiscovery = {
  recursiveTypeScriptRoots: [
    "apps/browser-service/src",
    "apps/api/src/lib/browser-state",
    "apps/api/src/lib/browser-runtime",
    "apps/api/src/lib/scrape-interact",
    "apps/api/src/db/schema",
  ],
  recursiveDatabaseGlobs: [
    "apps/api/src/db/migrations/*browser*.sql",
  ],
  closureEntryPoints: [
    "apps/api/src/lib/local-runtime-config.ts",
    "apps/api/src/services/local-retention-worker.ts",
    "apps/api/src/controllers/internal/browser-runs.ts",
    "apps/api/src/controllers/v2/browser.ts",
    "apps/api/src/controllers/v2/scrape-browser.ts",
    "apps/api/src/controllers/v2/browser-proxy.ts",
    "apps/api/src/harness-browser-service.ts",
  ],
  scanOnlyBridgeFiles: [
    "apps/api/src/config.ts",
    "apps/api/src/controllers/v2/types.ts",
    "apps/api/src/routes/internal.ts",
    "apps/api/src/routes/v2.ts",
    "apps/api/src/index.ts",
    "apps/api/src/harness.ts",
  ],
  explicitProductionRoots: [
    "apps/browser-service/contracts/private-v1.contract.json",
    "apps/browser-service/package.json",
    "apps/browser-service/tsconfig.json",
    "apps/browser-service/Dockerfile",
    "apps/browser-service/src/runtime-preflight.mjs",
    "scripts/local-firecrawl",
    "apps/api/package.json",
    "compose.local.yaml",
    ".env.example.local",
  ],
  requiredProductionPaths: [
    "apps/api/src/lib/browser-state/filesystem-store-internal.ts",
    "apps/api/src/lib/browser-state/transitions.ts",
    "apps/api/src/lib/browser-state/process-identity.ts",
    "apps/api/src/lib/browser-state/legacy-compatibility.ts",
    "apps/api/src/lib/scrape-interact/replay-envelope.ts",
  ],
  taskPlan:
    "docs/superpowers/plans/2026-07-19-browser-service-and-api.md",
  reviewedExclusions: [
    {
      id: "test_or_negative_fixture",
      suffix: /(?:\.test|\.spec|\.integration\.test)\.[cm]?[jt]sx?$/,
      requireMatch: true,
    },
    {
      id: "snip_fixture",
      prefix: "apps/api/src/__tests__/snips/",
      requireMatch: true,
    },
    {
      id: "scanner_rule_literal_source",
      exact: "apps/api/src/cli/browser-stale-contract-scan.ts",
      requireMatch: true,
    },
    {
      id: "generated_lockfile",
      exact: "apps/browser-service/pnpm-lock.yaml",
      requireMatch: true,
    },
    {
      id: "generated_or_vendor_tree",
      prefixes: ["apps/browser-service/dist/", "node_modules/"],
      requireMatchWhenPresent: true,
    },
  ],
} as const;

export const browserSchemaRolePolicy = {
  browserOwnedRoots: [
    "apps/browser-service/src/",
    "apps/api/src/lib/browser-state/",
    "apps/api/src/lib/browser-runtime/",
    "apps/api/src/lib/scrape-interact/",
  ],
  browserSchemaExactFiles: [
    "apps/api/src/controllers/internal/browser-runs.ts",
    "apps/api/src/controllers/v2/browser.ts",
    "apps/api/src/controllers/v2/scrape-browser.ts",
    "apps/api/src/controllers/v2/browser-proxy.ts",
  ],
  reviewedNonBrowserSchemaExactFiles: [
    "apps/api/src/config.ts",
    "apps/api/src/controllers/v2/types.ts",
  ],
} as const;
```

Recursively include every production `apps/browser-service/src/**/*.ts` and
every production TypeScript file under the three API library roots. Exclude
tests only after discovery, never by pruning a directory before enumeration.
Recursively include API database schema TypeScript and every browser-named SQL
migration. Add the explicit controller, service, config, entrypoint, harness,
Compose, environment, package, contract, Dockerfile, and runtime roots above.
Parse this plan's `Create:`/`Modify:` paths and require every
task-touched production path to be discovered, import-closed, or covered by
one exact reviewed exclusion.

Starting from every discovered/explicit TypeScript root, resolve local static
imports, re-exports, string-literal dynamic imports, CommonJS
`require("./local")` calls, and TypeScript
`import x = require("./local")` declarations to a fixed point. Use compiler AST
nodes rather than text matching. Support extensionless files, `.js`, `.cjs`,
and `.mjs` specifiers mapping to source `.ts`/`.tsx`/`.cts`/`.mts`, directory
`index` resolution, and repository tsconfig path aliases. Literal external
package imports/requires remain allowed without recursion. Reject unresolved
local edges and every nonliteral dynamic import, CommonJS require, or import-
equals reference whose local/external ownership cannot be proved, using
`inventory_module_reference_unresolved`. The recursive directory roots and
`closureEntryPoints` seed that closure. Generic API config/index/harness/route aggregators are
`scanOnlyBridgeFiles`: scan their own complete text, but do not let unrelated
v0/v1/application imports redefine browser-contract ownership. Shared
`controllers/v2/types.ts` is also a scanned bridge: Task 12 removes its own
legacy `.strict()` call, while its `../v1/types` dependency is an exact
`reviewed_non_browser_boundary` and does not import all legacy v1 contracts.

For every bridge file, maintain a checked exact import classification for every
ESM, dynamic-import, CommonJS, and import-equals edge, keyed by normalized
resolved target: `browser_follow` or
`reviewed_non_browser_boundary`. Recursively close every `browser_follow`
target. A browser target classified non-browser, an import absent from the
classification, a removed/renamed target, or a new import fails
`inventory_bridge_import_unclassified`. This is a scope boundary, not a
forbidden-file exclusion, and cannot hide any import reachable from a browser
closure entrypoint. Prefer dedicated browser lifecycle/route modules as
closure roots and keep generic bridges limited to registration calls. The
resulting normalized set plus bridge texts is checked production inventory and
lexical-rule input.

After inventory closes, parse every source for schema-bearing AST. Assign each
source one checked role: `browser_schema`, `reviewed_non_browser_schema`, or
`non_schema`. Schema-bearing files inside `browserOwnedRoots`, files reached by
a `browser_follow` edge, and `browserSchemaExactFiles` become
`browser_schema`; `reviewedNonBrowserSchemaExactFiles` are exact reviewed
boundaries; files with no schema-bearing AST become `non_schema`. A schema-
bearing source with no deterministic role, a reviewed file that disappears or
stops matching its declared boundary, or a browser-owned schema forced into a
non-browser role fails `inventory_schema_role_unclassified` before rule
scanning. Production and fixture runs use the same role derivation; no caller
may inject, replace, or override normalized source roles.

Expose the real CLI's normalized inventory and derived source roles in its
structured result before findings are evaluated. Temporary-workspace tests run
that CLI pipeline against checked fixture discovery roots, bridge
classifications, and exact boundaries. They assert inventory membership and
derived role first, then exact findings, so a discovery/closure success paired
with broken role propagation cannot accidentally pass rule assertions.

Reviewed exclusions may identify only tests/negative fixtures, snips, the
scanner's own rule-literal source, generated files, or vendor trees. Each exact
exclusion must match its declared candidate (or, for generated/vendor trees,
must match when that tree exists); stale or broadened exclusions fail
`inventory_stale_exclusion`. A discovered production path absent from the
inventory fails `inventory_discovery_unlisted`; a resolved imported path absent
from it fails `inventory_import_unclosed`; a task-touched production path that
escaped both fails `inventory_task_path_uncovered`. Missing required paths
fail separately. Only after all inventory checks pass may rule scanning start.

Use TypeScript's compiler AST for call/property/initializer structure and
bounded lexical rules for SQL/YAML/env/text. Report stable rule ID, path, line,
and sanitized match; never rewrite files. Lock these rules:

- `legacy_root_config`: reject namespace/profile-root identifiers and AST root
  composition that joins/resolves `canonicalRoot`, `stateRoot`, or
  `localBrowserStateRoot` with a namespace or literal `checkpoints` segment.
- `legacy_checkpoint_layer`: reject quoted/backtick `checkpoints` path segments,
  including terminal, slash, and backslash forms.
- `legacy_zod_strict`: reject direct `\.strict\s*\(` in every discovered or
  import-closed production source;
  closed schemas use `z.strictObject()`.
- `bare_url_validator`: in every `browser_schema` source, reject AST calls to
  `z.url()` or `z.string().url()`.
- `bare_uuid_validator`: in every `browser_schema` source, reject `z.uuid()`
  and `z.string().uuid()` except one call inside the declaration named
  `canonicalUuidSchema` in each of exactly
  `apps/browser-service/src/contracts.ts` and
  `apps/api/src/lib/scrape-interact/browser-service-contracts.ts`.
  Unrelated application config remains in the checked inventory for lexical
  rules but is explicitly outside browser-schema validator ownership.
- `typescript_node_test`: reject `node --test` commands targeting `.ts` or
  `.tsx`; `.mjs` bootstrap tests remain allowed.
- `database_storage_payload`: in SQL reject
  `\bstorage_state(?:_[a-z0-9]+)*\b`. In database/persistence TypeScript AST,
  reject Drizzle/row/select/insert column keys matching
  `^storageState(?:[A-Z][A-Za-z0-9]*)?$`. Explicitly allow in-memory
  `StorageStateV1.storageState` transport/reconstruction values outside
  database column/query structures.
- `split_adapter_activation`: reject separate run/capability activation names
  and require one exported `activateAdapterProcess` entry point; transactional
  rollback/concurrent-winner tests remain behavioral proof.
- `legacy_acceptance`: reject `observer.onAccepted(`,
  `onAccepted(processId)`, and `processId: string`.
- `wrong_reconciliation_category`: reject exact
  `reconciliation_execution_failed`.
- `stale_code_result`: inspect `codeRunResultSchema` and require exactly
  `stdout,result,stderr,exitCode,killed`; reject `fromCache`, missing/extra
  keys, missing exported `CodeRunResult`, or an alias targeting another schema.

`browser-stale-contract-scan.test.ts` creates an isolated temporary workspace
and always deletes it in `finally`. Table-drive every inventory-wide lexical
rule twice: once by writing a new production file under
`apps/browser-service/src/discovered/`, and once by importing a helper outside
the configured roots from a discovered API source. Put the forbidden pattern
in the new file and require the corresponding rule finding, proving neither
directory discovery nor import closure silently omits it. Include plain,
payload, JSON, arbitrary-suffix snake/camel database columns, multiline
`.strict\n  (`, direct `.strict (`, and quoted/backtick/backslash checkpoint
segments. Test schema-only URL/UUID rules with temporary sources explicitly
discovered through the real production CLI pipeline, never a role override.
Create a new file under
`apps/browser-service/src/discovered/schema-contract.ts` that imports Zod,
exports one strict schema, and contains both bare `.url()` and `.uuid()` calls.
Assert normalized inventory contains it, production derivation labels it
`browser_schema`, then assert exact `bare_url_validator` and
`bare_uuid_validator` findings for that path and line.

Create a second Zod schema helper outside configured roots and reach it only
through an exact checked `browser_follow` bridge import/re-export. Supply the
same production bridge-classification metadata and exported schema shape the
real scanner consumes, not test-only source-role data. Assert closure includes
the helper once, its derived role is `browser_schema`, and both exact validator
findings occur. Removing or changing the follow classification must fail the
inventory boundary before role/rule scanning.

Add discovered-root and browser-follow controls that export ordinary
non-schema helpers and use unrelated `.url()`/`.uuid()` method names without a
Zod schema-bearing AST. Through the same CLI result, assert both controls are
present, derive as `non_schema`, and produce neither schema-only rule. A
schema-bearing source whose role cannot be derived still fails
`inventory_schema_role_unclassified` before rule scanning.

Separate closure fixtures cover two-hop imports, re-exports, string-literal
dynamic imports, local literal `require`, TypeScript import-equals, tsconfig
aliases, `.js`→`.ts`, `.cjs`→`.cts`, `.mjs`→`.mts`, extensionless resolution,
and directory `index.ts`; every transitive file appears once in normalized
sorted inventory. A local CommonJS two-hop helper containing a forbidden global
pattern must be scanned. Literal external-package require is accepted without
recursion; nonliteral require/dynamic import and unresolved local CommonJS
edges fail `inventory_module_reference_unresolved`. A bridge fixture classifies
one browser registration edge of each supported syntax and proves its two-hop
forbidden helper is scanned. Another classifies an
unrelated v1/v2 schema import as a reviewed non-browser boundary and proves it
does not enter browser-contract inventory; changing either classification or
adding an unclassified bridge import fails before rule scanning. Real-tree
inventory must contain `controllers/v2/types.ts` but exclude
`controllers/v1/types.ts`; changing that exact boundary classification fails.
Deleting a
required path, injecting a discovered path that an
instrumented inventory drops, and injecting an imported path that an
instrumented closure drops must produce distinct missing-required,
`inventory_discovery_unlisted`, and `inventory_import_unclosed` failures before
rule scanning. Add a task-plan fixture whose production `Modify:` path escapes
both discovery and closure and expect `inventory_task_path_uncovered`.

Every reviewed exclusion has positive match coverage; rename/delete its
candidate and expect `inventory_stale_exclusion`. Test/snip/scanner/generated
fixtures remain excluded, while a production import of an excluded test or
scanner file fails closed instead of hiding the edge. UUID allowlist fixtures
prove exact two definitions pass while a third, renamed, moved, or wrong-file
call fails. Code-result fixtures prove the exact schema/alias passes while
added `fromCache`, missing `killed`, absent alias, or wrong alias target fails.
The real-tree discovery/import closure contains all five required previously
omitted helpers, covers every task-touched production path, and has zero rule
findings. CLI fixtures return exit 1 for bad/incomplete temporary trees and 0
for clean closed input.

```bash
pnpm --dir apps/api exec vitest run src/cli/browser-stale-contract-scan.test.ts
pnpm --dir apps/api check:browser-stale-contracts
```

Expected: every directory/import mutation proves its stale category fails,
all closure forms resolve, exclusions stay exact, required/task-touched paths
are covered, and the real discovered/import-closed production inventory exits
0. Full-CLI fixture output proves discovered and browser-followed schemas enter
inventory, derive `browser_schema`, and produce exact URL/UUID findings;
ordinary controls derive `non_schema` with no schema-only finding.

- [ ] **Step 5: Run deterministic regression**

```bash
export PATH=/home/mamba/.nvm/versions/node/v22.22.1/bin:$PATH
cd apps/browser-service
test "$(corepack pnpm --version)" = "10.33.0"
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm build
cd ../..
pnpm --dir apps/api exec vitest run --no-file-parallelism src/db/migrate.integration.test.ts src/lib/browser-runtime src/lib/browser-state src/lib/scrape-interact src/controllers/internal/browser-runs.test.ts src/controllers/v2/browser.test.ts src/controllers/v2/browser-proxy.test.ts src/controllers/v2/scrape-browser.test.ts
pnpm --dir apps/api exec vitest run src/cli/browser-stale-contract-scan.test.ts
pnpm --dir apps/api check:browser-stale-contracts
pnpm --dir apps/api build
```

Expected: all deterministic tests and builds PASS. Real Codex smoke reports
SKIP unless explicitly enabled; a skip never counts as host acceptance.

- [ ] **Step 6: Commit acceptance coverage**

```bash
git add apps/api/src/__tests__/snips/v2/lib.ts apps/api/src/__tests__/snips/v2/browser-local.test.ts apps/api/src/__tests__/snips/v2/scrape-browser.test.ts apps/api/src/__tests__/snips/v2/browser-real-codex.test.ts apps/api/src/cli/browser-stale-contract-scan.ts apps/api/src/cli/browser-stale-contract-scan.test.ts apps/api/package.json
apps/api/.husky/_/pre-commit
git commit -m "test: cover local browser runtime" -m "Exercise direct Browser, replayed Interact, profiles, origins, grants,
action coordination, stop, and restart against controlled fixtures.

Define the real Codex smoke for durable actions, callback deduplication,
zero model-tool events, and checked stale-contract enforcement."
```

## Final verification for this plan

- [ ] Prepend installed Node `22.22.1`; from process cwd
  `apps/browser-service`, assert `node --version` is `v22.22.1` and
  `corepack pnpm --version` returns exactly `10.33.0`.
- [ ] Search this plan for Browser Service Corepack calls that pass pnpm's
  `--dir` option instead of changing process cwd first; expect zero matches.
- [ ] Run Browser Service frozen install, test, and build through Corepack;
  expect all PASS and no lockfile change. `pnpm list --depth 0` must report the
  11 exact direct versions from Task 1, including production TypeScript
  `5.9.3` and Vitest `4.1.9`; no direct dependency may contain a range or tag.
- [ ] Run Browser Service TypeScript tests only through `vitest run`; inspect
  Tasks 1-6 files for explicit
  `import { describe, expect, test, vi } from "vitest"`. Run only the two `.mjs`
  bootstrap tests through `node --test`.
- [ ] Run both independent private-contract inventory tests; expect Browser
  Service and API normalized contracts/fingerprints equal the one canonical
  V1 fixture and reject a one-field drift mutation. Search all planned schema
  snippets for permissive UUID/URL validators; expect only the shared local
  primitive definitions to call `.uuid()` and no bare `.url()`. Both sides
  reject uppercase UUIDs and file/mailto/ftp/credential URLs.
- [ ] Run Task 15 checked discovery/import-closure scanner and its temporary
  mutation suite. Require recursive production roots, transitive local import
  closure across ESM, dynamic imports, CommonJS require, and TypeScript import-
  equals, five named omitted helpers, and every task-touched production path in
  normalized inventory. Require every scan-only bridge edge to retain an exact
  browser-follow/non-browser-boundary classification; unclassified changes
  fail, browser edges close recursively, and unrelated aggregator imports do
  not expand scope. Directory-discovered and imported forbidden files must fail
  with exact rule IDs; missing closure, nonliteral/unresolved module edges,
  stale exclusions, or escaped task paths fail before scanning. Real tree
  reports zero findings. Negative tests and scanner rule source are exact
  structural exclusions. Checked source roles classify every schema-bearing
  file; bare UUID calls in `browser_schema` sources are AST-allowlisted only in
  two named `canonicalUuidSchema` declarations and bare URL calls are absent.
  Full-CLI fixtures prove newly discovered and browser-followed schemas derive
  as `browser_schema` before exact URL/UUID findings, while ordinary controls
  derive as `non_schema` and produce no schema-only finding. Missing/changed
  production classification fails closed; fixtures never override source
  roles. Direct `.strict(` calls are absent across the discovered closed
  inventory.

  ```bash
  pnpm --dir apps/api exec vitest run \
    src/cli/browser-stale-contract-scan.test.ts
  pnpm --dir apps/api check:browser-stale-contracts
  ```
- [ ] Run `0007_browser_control_generation.sql` migration and cross-process
  race tests. Expect singleton/epoch/nonce/API identity constraints, exact
  activation idempotency, newer takeover ordering, and a paused old mutation
  to finish before epoch activation/snapshot; every later old mutation fails
  before filesystem effect.
- [ ] Run `0008_browser_adapter_bindings.sql` migration tests transactionally.
  Invalid/noncanonical legacy action job IDs fail preflight with zero data/DDL
  change. A populated valid legacy capability succeeds because `NOT NULL`
  drops before nulling; migration interrupts unfinished legacy runs, revokes
  old capabilities, and enforces pending/activated/null/immutable constraints.
- [ ] Run Task 9/10 adapter authorization tests. Before host work, expect run
  and capability to persist equal canonical job/supervisor IDs; accepted
  process activates both in one transaction exactly once. Injected failure
  rolls back both rows. Prompt and code await the same acceptance barrier;
  wrong first-callback job, wrong supervisor/process, pending/revoked
  capability, and stale restart identity perform zero action/source writes;
  exact persisted binding succeeds. Code source additionally waits for one
  authenticated internal CDP handshake whose HTTP 101 follows Browser Service
  writer acquisition; failed setup revokes its grant and executes no source.
- [ ] Run `pnpm --dir apps/api build`; expect PASS.
- [ ] Run Task 15 focused API tests; expect all PASS.
- [ ] Run Task 8 database integration tests with `--no-file-parallelism`;
  expect snapshot/recovery/restart/retention ordering PASS. A populated
  foundation `replay/<owner>/<scrape>/<uuid>.json` checkpoint and cleanup
  intent reconcile in place with unchanged database paths and no file move.
  PostgreSQL contains metadata only; replay reconstruction reads and validates
  canonical `StorageStateV1` from the direct-root file.
- [ ] Run `pnpm --dir apps/api harness pnpm test:snips:local-browser`; expect
  lifecycle cases PASS and host execution unavailable until its plan lands.
- [ ] Run
  `docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml config --quiet`;
  expect exit 0.
- [ ] Resolve Playwright raw manifest again; expect digest equals committed
  Dockerfile digest. Build Browser Service twice with `--pull --no-cache`;
  expect Node `v22.22.1`, Playwright `1.61.1`, production TypeScript `5.9.3`,
  constrained evaluate parser smoke, and `pwuser` both times.
- [ ] In both digest-pinned `browser-test` images, run real bundled-Chromium
  egress tests. Require positive controls plus zero private HTTP/WS hits, proxy
  observation/rejection for top-level and subresources across localhost,
  127/8, link-local IPv4/IPv6, and DNS-private targets, and zero hardened
  QUIC/WebRTC UDP packets. Missing proof is failure, never skip.
- [ ] In both `browser-test` images, run replay restore tests. Require cookies,
  localStorage, and IndexedDB equality immediately after `setStorageState`, no
  upstream/DNS/policy/dial ingress violations through semantic verification,
  state-path file containing only canonical `StorageStateV1` bytes, exact
  foundation-canonical request/file checksum equality, and semantic-normalized
  request/export equality, including unsorted foundation arrays. Require a
  post-open `finalUrl` ingress/DNS/policy/dial positive control. Pre-launch
  validation failures launch nothing. Only trusted `preSpawn` launch rejection
  may discard normally; timeout/post-spawn rejection retains
  `launch_cleanup_unverified`, working state, and globally closed admission
  until process restart guarantees termination. Its process-local token then
  disappears; existing Task 3 reconciliation retains the unreferenced working
  generation within the 10-minute grace and may become ready, while a later
  reconciliation generation removes it crash-safely only after the grace.
  Every returned-context restore failure
  performs no prepare/finalize/profile publication; verified cleanup removes
  ownership, while any unverified context/listener/socket/path remains in
  closed-admission `cleanup_failed` ownership for public-API sweeper retry.
  Invoke `context.close()` once and preserve its promise; bounded public
  `context.browser()?.close()` may recover graceful failure, while unavailable
  or failed fallback retains handles/promises and never uses private APIs.
- [ ] Run
  `docker compose --project-name firecrawl --project-directory . -f compose.yaml -f compose.local.yaml build browser-service api`;
  expect exit 0.
- [ ] Inspect Compose; expect only API published on `127.0.0.1:3002`.
- [ ] With local flag false, expect the existing hosted branch unchanged. With
  local flag true, install Gemini/Fireworks/Firecrawl Cloud spies, run prompt
  and code cases, and expect zero provider/cloud calls or fallback.
- [ ] With browser flag false and local persistence enabled, advance one
  retention interval; expect operational and artifact phases once, browser
  phase zero, and no coordinator. With flag true, expect one API owner and no
  harness/service retention owner.
- [ ] With flag true and dependencies healthy, expect Browser lifecycle snips
  PASS; prompt/code remain typed unavailable until host adapter exists.
- [ ] On every first/API-only startup, require live discovery then one
  idempotent control handoff before migrations or database recovery. Restart
  only API after checkpoint/profile mutations; expect stable process nonce,
  fresh generation, full old session/context/stream/grant/writer/working-copy
  closure, changed digest reconciliation, old-API stale rejection, and ready
  only for matching process/generation/digest. Every HTTP/WS stale response
  synchronously closes only its matching API binding.
- [ ] Lose handoff transport before/during drain/after service mint, crash API
  before request send/during pre-mint drain/after service mint, race two live
  API instances, and restart Browser Service during handoff. Post-mint exact
  replay mints once. During pre-mint drain, a fresh replacement tuple adopts
  the one service-owned drain, while old handler/retry returns superseded;
  repeat across multiple owner crashes and expect one physical drain/one mint.
  A live owner cannot be stolen. After prior mint, true replacement performs a
  new full drain and may mint again. From exactly 1,023 accepted tuples, an
  unknown orphan replacement reserves tuple 1,024; from exactly 1,024 it fails
  without state change. Process restart creates a fresh identity; no
  database recovery runs before confirmed service and durable mutation drains.
- [ ] Restart Browser Service; expect process nonce change closes API gate,
  completes a new handoff, then interrupts durable work and reconciles once.
  A same-process generation change means this API was superseded: it closes
  permanently and never retakes control automatically.
- [ ] Inject partial reconciliation, lost response, API crash before gate open,
  and process change between attempts. Same-generation attempts send
  byte-identical body/digest and use cached success; API replacement and
  process change each perform a fresh handoff before closed recovery and one
  new immutable snapshot. Retry/backoff/budget/cooldown stay bounded, and stop
  cannot reopen the gate.
- [ ] Inject reconciliation validation/planning errors; expect zero mutation.
  Inject rename/delete/fsync failures after execution starts; expect only the
  exact sorted plan prefix moved/deleted, all unrelated entries unchanged,
  readiness closed, and same-digest retry convergence. Equal basenames across
  replay/profile committed/staging/working paths never collide.
- [ ] Race shutdown against accepted and in-flight reconciliation; expect
  `StartupAdmission.reconcile()` to reject/withhold success, no new filesystem
  call after draining, and no readiness resurrection after listener close.
- [ ] Hold proxy setup after private-grant creation, close the gate, then
  release it; expect grant revocation and no upstream open. Successful relay
  setup holds the mutation lease through handshake, releases it before stream
  lifetime, and revokes the private grant on connect failure.
- [ ] Inspect action tests: every accepted proposal persists `prepared` before
  dispatch; matching known callback replays do not dispatch; hash mismatch
  fails; each strict result/response cap is enforced; unsupported/cyclic/
  non-finite/oversized post-dispatch output becomes uncached
  `outcome_unknown` and terminates run/session; no action auto-retries.
- [ ] Run harness twice with hostile inherited override variables. Expect
  override rejection before container launch, then two clean runs with unique
  container/project, nonce, root, port, key, and disposable API
  database. Inject failure/signal after registration, root, database, partial
  container run, and full run; expect cleanup was registered before creation,
  removes container/database/root in reverse order once, and touches no
  unmanaged resource.
- [ ] After host plan, run real Codex smoke three times; expect three PASS runs,
  contiguous ledgers, exact effect counts, zero tools/approvals, code
  `relay_ready` ordering, and cleanup.
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
- Adapter authorization: migration persists canonical job/supervisor identity
  on run/capability before dispatch; adapter acceptance atomically binds one
  positive process in both rows before model/code/callback work. Prompt and
  code inputs share the awaited acceptance contract and code output is closed
  and bounded. Callback headers, body, run, and active capability must match;
  restart preserves audit identity while revoking stale authority.
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
  256 KiB per code text field, 512 KiB aggregate code text, 25 actions,
  26 turns, 300 seconds, and approved HTTP mappings appear in implementation
  and tests.
- Security: model receives no MCP, tools, browser transport, capability,
  endpoint, credential, shell, workspace, Docker, or arbitrary network;
  Browser Service remains private, manually proxies Chromium with
  `bypass:"<-loopback>"`, disables QUIC/non-proxied WebRTC UDP, and validates
  every egress destination.
- Rollout: real Codex smoke is defined here but cannot pass by skip; host plan
  must run it against active installed Codex under rolling capability gate
  before feature enablement.
- Startup authority: Browser Service is live before API, but no Browser route
  admits work until API obtains a service-drained control generation before
  migrations/recovery, captures one repeatable-read snapshot, reconciles, and
  validates matching process/generation/digest ready health. `processNonce`
  remains stable for service-process lifetime; API-only restart always mints a
  new fenced generation. API and service share one direct canonical root;
  existing `replay/...` paths remain unchanged.
- Mutation drain: gate close rejects admission synchronously, then coordinator
  awaits local leases. Every durable lease additionally locks the singleton
  database control epoch across filesystem effect and database CAS. New API
  activation waits for old admitted mutations, then increments epoch so old
  future mutations fail before filesystem effect. Dead cleanup-intent writers
  converge under exact process identity and CAS before snapshot; live/unknown
  writers remain authoritative.
- Mutation coverage: session/profile/run transitions, actions, capabilities,
  grants, artifact attachment, stop, and controller-facing writes all use
  short gate leases. Public and internal code relay setup each hold one only
  through upstream handshake, never stream lifetime. Code source starts only
  after the internal relay is ready and its Browser Service writer is held.
  Host execution and artifact streaming hold none; callback and gate-close
  races either drain known completion or recover conservatively.
- Ownership and retries: API process alone owns operational, artifact, and
  browser-state retention plus recovery; harness owns only fresh disposable
  process/container/root/database lifecycle. Each handoff/reconciliation cycle
  has 4 attempts and 250/500/1,000 ms backoff; one startup budget spans process
  churn and each runtime cycle has a 60-second budget plus 30-second cooldown.
  One control generation freezes one reconciliation body;
  same-generation retries are byte-exact. Process change gets a new handoff;
  stale generation permanently fences the superseded API.
- Toolchain: every Browser Service install/test/build/start uses installed Node
  `22.22.1`, Corepack pnpm `10.33.0`, frozen lock, Playwright package/image
  `1.61.1`, production TypeScript parser `5.9.3`, exact direct dependencies,
  Vitest `4.1.9`, and committed Noble digest; two no-cache builds verify
  identities, evaluate parsing, and real bundled Chromium.
- Replay restore: existing generation plus checkpoint is rejected. Otherwise
  PostgreSQL carries complete checkpoint metadata while the direct-root
  `replay/...` file alone carries canonical storage bytes. API reconstructs the
  request from both. Raw file and foundation-canonical request bytes/checksum
  match; semantic-normalized request/export state matches after
  `setStorageState`, or all runtime/profile work is discarded without
  publication.
- Contract drift: one canonical V1 inventory locks every route, field, type,
  bound, status, header, and response cap; Browser Service and API consume and
  fingerprint it independently. Checked production-root discovery, fixed-point
  import closure, and positive mutation fixtures reject every named stale
  contract or uncovered production path.
- Reconciliation safety: complete authority validates before candidate
  mutation; procfd-anchored held handles confine every walk/rename/fsync/delete,
  and only canonical recognized old orphans enter same-root quarantine. One
  immutable manifest is file-fsynced and parent-fsynced before execution;
  source/destination phases, both parent fsyncs, completion marker, and old-plan
  recovery return deterministic counts after every crash boundary. Every record
  and pending phase is validated read-only before mutation; current plan stores
  only current entries plus one pending-only union count, while historical
  completions contribute zero. A lone final completion marker is never path
  authority and permits only self/empty-ancestor deletion after global zero-leaf
  and exact-skeleton proof. No partial quarantine without a validated manifest
  is interpreted. Exact profile
  UUID generation-directory grammar, shared canonical tree identity, early
  global entry/depth/byte bounds, descendant mtime, special/hard-link rejection,
  handle cleanup after abort, admission checks, and redacted logs are covered.
  Draining cannot resurrect readiness.
