# Local Browser Service and API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the private persistent Browser Service and connect existing
`/v2/browser` and scrape Interact routes to it, including profile generations,
typed browser operations, strict navigation policy, and API-only live view/CDP.

**Architecture:** Firecrawl API remains authorization and durable-state owner.
A new private TypeScript service owns Chromium processes and profile files. A
validating loopback egress proxy is the primary SSRF/DNS-rebinding boundary;
Playwright routing is defense in depth. API mints opaque proxy grants and
relays live-view/CDP WebSockets without returning private endpoints.

**Tech Stack:** Node.js 22, TypeScript 5.9, Express 5, `ws`, Zod 4,
Playwright 1.61.1/Chromium, `ipaddr.js`, PostgreSQL-backed API state, Vitest,
Node test runner, Docker Compose.

---

## Scope and prerequisite

This plan starts after the gate/state/replay plan has landed. It consumes:

- `apps/api/src/lib/browser-state/store.ts`
- `apps/api/src/lib/browser-state/types.ts`
- `apps/api/src/lib/scrape-interact/replay-envelope.ts`
- `apps/api/src/lib/scrape-interact/replay-store.ts`
- migration `apps/api/src/db/migrations/0004_browser_interact_foundation.sql`

Host execution is a later plan. This plan defines its narrow boundary in
`apps/api/src/lib/browser-runtime/execution-adapter.ts`:

```ts
executePromptRun(input, signal)
executeCodeRun(input, signal)
cancelExecutionRun(runId, reason)
```

Default implementation is unavailable and returns typed 503 categories:
`codex_unavailable` for prompt mode and `sandbox_unavailable` for code mode.
API unit tests inject a fake adapter. This plan does not claim real prompt/code
execution acceptance; host execution plan replaces default and owns that gate.

Keep `LOCAL_BROWSER_SERVICE_ENABLED=false` until final acceptance. Hosted mode
retains existing behavior. Local-persistence mode returns typed unavailable
responses and never falls back to hosted services. Local Compose sets it true
only after Browser Service and API proxy gates pass.

## File map

### New Browser Service

- `apps/browser-service/package.json` — scripts and pinned runtime packages.
- `apps/browser-service/pnpm-lock.yaml` — reproducible dependency graph.
- `apps/browser-service/tsconfig.json` — NodeNext strict build.
- `apps/browser-service/Dockerfile` — private Chromium service image.
- `apps/browser-service/src/config.ts` — validated service configuration.
- `apps/browser-service/src/contracts.ts` — strict private request/response and
  typed-operation schemas.
- `apps/browser-service/src/errors.ts` — typed internal errors and HTTP mapping.
- `apps/browser-service/src/auth.ts` — service identity, correlation, deadline.
- `apps/browser-service/src/network-policy.ts` — URL/domain/IP normalization.
- `apps/browser-service/src/egress-proxy.ts` — DNS-pin HTTP/CONNECT proxy.
- `apps/browser-service/src/profile-store.ts` — working copies and immutable
  atomic generations.
- `apps/browser-service/src/evaluate-policy.ts` — constrained page-expression
  validator.
- `apps/browser-service/src/operations.ts` — typed Playwright operation engine.
- `apps/browser-service/src/session-registry.ts` — Chromium lifecycle, leases,
  origin set, TTLs, and close.
- `apps/browser-service/src/streams.ts` — passive frames, interactive input,
  and private CDP bridging.
- `apps/browser-service/src/artifacts.ts` — bounded screenshot/trace artifact
  capture for authenticated API requests only.
- `apps/browser-service/src/server.ts` — authenticated HTTP/WS routes.
- `apps/browser-service/src/index.ts` — startup and ordered shutdown.
- Adjacent `*.test.ts` files — deterministic contract/security tests.

### Firecrawl API

- `apps/api/src/config.ts` — local flag and private service configuration.
- `apps/api/src/lib/local-runtime-config.ts` — fail-closed local validation.
- `apps/api/src/lib/scrape-interact/browser-service-client.ts` — replace loose
  method/path helper with typed, deadline-aware client methods.
- `apps/api/src/lib/browser-runtime/orchestrator.ts` — bridge durable state,
  replay, profiles, service sessions, adapter runs, and cleanup.
- `apps/api/src/lib/browser-runtime/execution-adapter.ts` — host adapter
  interface plus fail-closed unavailable implementation.
- `apps/api/src/lib/browser-state/capability-store.ts` — issue, budget, redeem,
  and revoke server-held typed-operation authority.
- `apps/api/src/lib/browser-state/proxy-grant-store.ts` — issue, redeem, and
  revoke hashed public stream grants.
- `apps/api/src/lib/browser-runtime/proxy-urls.ts` — grant creation and public
  opaque URL construction.
- `apps/api/src/lib/browser-runtime/artifacts.ts` — validate, stream to MinIO,
  persist the existing local manifest, and attach run references.
- `apps/api/src/lib/artifacts/{manifest,local-manifest}.ts` — carry optional
  SHA-256 for existing artifacts and require it for browser artifacts.
- `apps/api/src/controllers/v2/browser.ts` — direct API compatibility.
- `apps/api/src/controllers/v2/scrape-browser.ts` — replayed Interact and stop.
- `apps/api/src/controllers/v2/browser-proxy.ts` — no-store viewer and WS relay.
- `apps/api/src/controllers/internal/browser-runs.ts` — adapter-only operation
  and CDP callbacks that resolve server-held run authority.
- `apps/api/src/routes/internal.ts` — adapter-token authenticated callbacks.
- `apps/api/src/index.ts` — mount the internal callback router.
- `apps/api/src/routes/v2.ts` — proxy HTTP/WS routes.
- `apps/api/src/__tests__/snips/v2/lib.ts` — direct Browser helpers and expanded
  Interact body.
- `apps/api/src/__tests__/snips/v2/browser-local.test.ts` — direct API and proxy
  acceptance.
- `apps/api/src/__tests__/snips/v2/scrape-browser.test.ts` — replay, stop,
  origin, and profile acceptance.
- `apps/api/package.json` — managed local-browser snip command.
- `apps/api/src/harness.ts` — reuse the disposable PostgreSQL and controlled
  fixture path while skipping the unavailable host Go build.
- `apps/api/src/harness-browser-service.ts` — build, configure, health-check,
  and remove the disposable Browser Service used by local-browser snips.

### Local runtime

- `compose.local.yaml` — private service, API env, profile volume.
- `.env.example.local` — non-secret names and disabled-by-default flag.

## Private contract locked by this plan

Every request carries `Authorization: Bearer <service key>`,
`x-firecrawl-correlation-id`, and `x-firecrawl-deadline` (ISO timestamp).
Unknown JSON fields fail with 400.

```text
POST   /v1/sessions
GET    /v1/sessions/:runtimeSessionId
POST   /v1/sessions/:runtimeSessionId/operations
POST   /v1/sessions/:runtimeSessionId/grants
DELETE /v1/sessions/:runtimeSessionId/grants/:grantId
DELETE /v1/sessions/:runtimeSessionId
POST   /v1/profile-generations/:generationId/finalize
DELETE /v1/profile-generations/:generationId
WS     /v1/sessions/:runtimeSessionId/streams/passive
WS     /v1/sessions/:runtimeSessionId/streams/interactive
WS     /v1/sessions/:runtimeSessionId/streams/cdp
GET    /health/live
GET    /health/ready
POST   /health/session
```

Only API calls these endpoints. `runtimeSessionId` is never public. Browser
Service grants are short-lived relay authorizations, distinct from public
hashed API proxy grants.

## Verified references

- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext):
  `storageState({ indexedDB: true })` is available to existing Playwright 1.58
  stateless scrape checkpoint export. `setStorageState()` requires 1.59+, so
  Browser Service pins 1.61.1 for restore and persistent-session work.
- [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype):
  `connectOverCDP()` is Chromium-only and lower fidelity than Playwright
  protocol. CDP exists only for compatibility and stays behind private/API
  relays; Browser Service operations use its owned Playwright context.
- Browser context routing does not see service-worker-owned traffic unless
  service workers are blocked. Every created context sets
  `serviceWorkers: "block"`; the DNS-pinning egress proxy remains the primary
  SSRF/rebinding boundary and routing is defense in depth.

### Task 1: Scaffold strict private service and contracts

**Files:**
- Create: `apps/browser-service/package.json`
- Create: `apps/browser-service/tsconfig.json`
- Create: `apps/browser-service/src/contracts.ts`
- Create: `apps/browser-service/src/config.ts`
- Create: `apps/browser-service/src/errors.ts`
- Create: `apps/browser-service/src/auth.ts`
- Create: `apps/browser-service/src/contracts.test.ts`
- Create: `apps/browser-service/src/auth.test.ts`
- Create: `apps/browser-service/pnpm-lock.yaml`

- [ ] **Step 1: Add package metadata and strict build**

```json
{
  "name": "firecrawl-browser-service",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "node --import tsx --test src/*.test.ts"
  },
  "dependencies": {
    "express": "^5.2.1",
    "ipaddr.js": "^2.3.0",
    "playwright": "1.61.1",
    "ws": "^8.21.0",
    "zod": "4.1.12",
    "typescript": "^5.9.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^22.15.30",
    "@types/ws": "^8.18.1",
    "tsx": "^4.21.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Run: `pnpm --dir apps/browser-service install --lockfile-only`

Expected: `apps/browser-service/pnpm-lock.yaml` pins Playwright 1.61.1.

- [ ] **Step 2: Write failing strict-contract and auth tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRequestSchema, operationRequestSchema } from "./contracts.js";

test("create rejects unknown fields and ttl inversion", () => {
  assert.equal(createSessionRequestSchema.safeParse({
    publicSessionId: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
    ttlSeconds: 600,
    activityTtlSeconds: 601,
    initialOrigins: [],
    extra: true,
  }).success, false);
});

test("operation is a closed discriminated union", () => {
  assert.equal(operationRequestSchema.safeParse({
    operation: { kind: "shell", command: "id" },
    expectedSessionVersion: 1,
  }).success, false);
});
```

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { authorizePrivateRequest } from "./auth.js";

test("private auth requires key, correlation, and future deadline", () => {
  assert.throws(() => authorizePrivateRequest({
    authorization: "Bearer wrong",
    correlationId: "",
    deadline: new Date(Date.now() - 1).toISOString(),
  }, "expected"), /unauthorized|deadline/i);
});
```

- [ ] **Step 3: Run tests and confirm red state**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/contracts.test.ts src/auth.test.ts`

Expected: FAIL because `contracts.ts` and `auth.ts` do not exist.

- [ ] **Step 4: Add closed schemas, typed errors, config, and auth**

`contracts.ts` must export strict Zod schemas and inferred types. Core schema:

```ts
const originSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value;
});

export const browserOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot") }).strict(),
  z.object({ kind: z.literal("click"), ref: z.string().max(128) }).strict(),
  z.object({ kind: z.literal("fill"), ref: z.string().max(128), value: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("type"), ref: z.string().max(128), value: z.string().max(20_000), delayMs: z.number().int().min(0).max(250).default(0) }).strict(),
  z.object({ kind: z.literal("press"), ref: z.string().max(128), key: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("select"), ref: z.string().max(128), values: z.array(z.string().max(512)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("scroll"), deltaX: z.number().int().min(-10_000).max(10_000), deltaY: z.number().int().min(-10_000).max(10_000) }).strict(),
  z.object({ kind: z.literal("wait"), milliseconds: z.number().int().min(0).max(30_000) }).strict(),
  z.object({ kind: z.literal("get_text"), ref: z.string().max(128).optional() }).strict(),
  z.object({ kind: z.literal("get_url") }).strict(),
  z.object({ kind: z.literal("navigate"), url: z.string().url().max(8_192) }).strict(),
  z.object({ kind: z.literal("evaluate"), expression: z.string().min(1).max(20_000), args: z.record(z.string(), z.json()).default({}) }).strict(),
]);

export const replayBrowserSettingsSchema = z.object({
  headers: z.record(z.string(), z.string()),
  cookies: z.array(z.object({
    name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
    expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
  }).strict()),
  viewport: z.object({
    width: z.number().int().positive().max(7680),
    height: z.number().int().positive().max(4320),
    deviceScaleFactor: z.number().positive().max(4),
    isMobile: z.boolean(), hasTouch: z.boolean(),
  }).strict(),
  deviceName: z.string().max(128).optional(),
  userAgent: z.string().min(1).max(1024),
  locale: z.string().min(1).max(64),
  timezoneId: z.string().min(1).max(128).optional(),
  geolocation: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(100_000),
  }).strict().optional(),
  location: z.object({
    country: z.string().min(1).max(32),
    languages: z.array(z.string().min(1).max(64)).max(20),
  }).strict(),
  proxy: z.object({
    kind: z.enum(["basic", "stealth", "enhanced", "auto"]),
    country: z.string().min(1).max(32).optional(),
    credentialRef: z.string().uuid().optional(),
  }).strict(),
  skipTlsVerification: z.boolean(),
  blockAds: z.boolean(),
  lockdown: z.boolean(),
}).strict();

export const createSessionRequestSchema = z.object({
  publicSessionId: z.string().uuid(),
  ownerId: z.string().uuid(),
  scrapeId: z.string().uuid().nullable().default(null),
  ttlSeconds: z.number().int().min(30).max(3600),
  activityTtlSeconds: z.number().int().min(10).max(600),
  streamWebView: z.boolean(),
  initialOrigins: z.array(originSchema).max(8),
  allowedDomains: z.array(z.string().min(1).max(253)).max(8).default([]),
  profile: z.object({
    profileId: z.string().uuid(),
    baseGenerationId: z.string().uuid().nullable(),
    mode: z.enum(["writer", "snapshot"]),
  }).strict().nullable().default(null),
  replay: z.object({
    checkpointId: z.string().uuid(),
    finalUrl: z.string().url(),
    fingerprint: z.object({
      finalUrl: z.string().url().max(8_192),
      titleSha256: z.string().regex(/^[a-f0-9]{64}$/),
      bodyTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    navigationPolicyVersion: z.literal(1),
    browserSettings: replayBrowserSettingsSchema,
  }).strict().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.activityTtlSeconds > value.ttlSeconds) {
    ctx.addIssue({ code: "custom", message: "activityTtlSeconds must not exceed ttlSeconds" });
  }
});

export const operationRequestSchema = z.object({
  operation: browserOperationSchema,
  expectedSessionVersion: z.number().int().nonnegative(),
  capabilityId: z.string().uuid(),
}).strict();

export type BrowserOperation = z.infer<typeof browserOperationSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type ReplayBrowserSettings = z.infer<typeof replayBrowserSettingsSchema>;
```

`auth.ts` uses `timingSafeEqual`, rejects expired/deadline-over-5-min requests,
and returns `{ correlationId, deadline: Date }`. `errors.ts` exports
`BrowserRuntimeError` with only approved categories and `toHttpError()`.
`config.ts` validates `PORT`, `BROWSER_SERVICE_API_KEY`,
`BROWSER_PROFILE_ROOT`, `MAX_BROWSER_SESSIONS`, and timeout/output limits.
Use exact proxy defaults: 32 KiB request headers, 64 KiB response headers,
32 MiB buffered HTTP response bodies, 128 MiB in each CONNECT direction, 32
concurrent tunnels, 60 seconds idle per tunnel, and the smaller of the request
deadline or 3600 seconds for total tunnel life. The explicit `src/*.test.ts`
argument is required: Node's default discovery must not silently skip the
TypeScript test files.

- [ ] **Step 5: Run tests and build**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/contracts.test.ts src/auth.test.ts`

Expected: PASS.

Run: `pnpm --dir apps/browser-service build`

Expected: PASS with output under `apps/browser-service/dist`.

- [ ] **Step 6: Commit scaffold**

Run: `git add apps/browser-service/package.json apps/browser-service/pnpm-lock.yaml apps/browser-service/tsconfig.json apps/browser-service/src/contracts.ts apps/browser-service/src/contracts.test.ts apps/browser-service/src/config.ts apps/browser-service/src/errors.ts apps/browser-service/src/auth.ts apps/browser-service/src/auth.test.ts`

Run: `apps/api/.husky/_/pre-commit`

If hooks modify files, run the same `git add` command and hook command again.

Run:

```bash
git commit -m "feat: define private browser service contracts" -m "Add strict schemas, request authentication, deadlines, and typed errors
for the local persistent browser runtime.

Pin the standalone service toolchain and validate its initial contract."
```

### Task 2: Enforce public egress and DNS pinning

**Files:**
- Create: `apps/browser-service/src/network-policy.ts`
- Create: `apps/browser-service/src/network-policy.test.ts`
- Create: `apps/browser-service/src/egress-proxy.ts`
- Create: `apps/browser-service/src/egress-proxy.test.ts`

- [ ] **Step 1: Write hostile URL and rebinding tests**

```ts
test("blocks all non-public address forms", async () => {
  for (const target of [
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/",
    "http://10.0.0.1/", "http://100.64.0.1/", "file:///etc/passwd",
  ]) await assert.rejects(() => resolvePublicTarget(target, fakeLookup), /target_blocked/);
});

test("pins the validated address for CONNECT", async () => {
  const lookup = sequenceLookup(["93.184.216.34"], ["127.0.0.1"]);
  const dial = recordingDialer();
  await proxyConnect("example.test:443", { lookup, dial });
  assert.deepEqual(dial.addresses, ["93.184.216.34"]);
  assert.equal(lookup.calls, 1);
});

test("allows a validated public target on a non-default port", async () => {
  const lookup = staticLookup(["93.184.216.34"]);
  const dial = recordingDialer();
  await proxyConnect("example.test:8443", { lookup, dial });
  assert.deepEqual(dial.ports, [8443]);
});
```

Use a recording dialer in these tests; it must never contact
`93.184.216.34`. Add explicit rejected cases for documentation-only ranges
`192.0.2.0/24`, `198.51.100.0/24`, and `203.0.113.0/24` so a reserved test
address cannot accidentally be treated as public unicast.

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/network-policy.test.ts src/egress-proxy.test.ts`

Expected: FAIL because target resolution and proxy do not exist.

- [ ] **Step 3: Add URL normalization and pinned dial result**

```ts
export type ResolvedPublicTarget = {
  url: URL;
  hostname: string;
  port: number;
  addresses: readonly string[];
};

export async function resolvePublicTarget(
  raw: string,
  lookup: Lookup = systemLookup,
): Promise<ResolvedPublicTarget> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw runtimeError("target_blocked", "Only HTTP(S) targets are allowed");
  }
  if (url.username || url.password) {
    throw runtimeError("target_blocked", "URL credentials are not allowed");
  }
  const hostname = domainToASCII(url.hostname.replace(/\.$/, "").toLowerCase());
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw runtimeError("target_blocked", "Target hostname is blocked");
  }
  const addresses = ipaddr.isValid(hostname)
    ? [hostname]
    : [...new Set((await lookup(hostname)).map(answer => answer.address))];
  if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
    throw runtimeError("target_blocked", "Target resolved to a blocked address");
  }
  return {
    url,
    hostname,
    port: parsePublicPort(url.port, url.protocol),
    addresses,
  };
}
```

`isForbiddenAddress()` must reject every `ipaddr.js` range except public
`unicast`, plus carrier-grade NAT `100.64.0.0/10` and IPv4-mapped IPv6 forms.
`parsePublicPort()` accepts every integer port from 1 through 65535 for an
otherwise valid HTTP(S) URL; non-default ports are not a reason to reject a
public target. It must never cache a DNS answer across requests.

- [ ] **Step 4: Add the loopback HTTP/CONNECT proxy**

`createValidatingEgressProxy()` must:

```ts
const target = await resolvePublicTarget(requestUrl, lookup);
const address = chooseAddress(target.addresses);
const upstream = target.url.protocol === "https:"
  ? tls.connect({ host: address, port: target.port, servername: target.hostname })
  : net.connect({ host: address, port: target.port });
```

For `CONNECT`, parse exactly one RFC 3986 host and explicit port from the
authority, reject credentials, paths, query, fragments, whitespace, control
bytes, missing ports, and ports outside 1 through 65535, then validate the
equivalent HTTPS target and dial the selected IP directly. Permit validated
public targets such as `example.test:8443`; do not restrict CONNECT or plain
HTTP(S) traffic to 80/443. For plain HTTP, require absolute-form HTTP(S),
remove proxy-only headers, set `Host` from the validated URL, cap response
headers/body, and follow no redirects itself. Reject malformed authorities,
upgrade requests outside CONNECT, and responses over configured bounds. Bind
only `127.0.0.1` on an ephemeral port.

Apply backpressure in both CONNECT directions. Count bytes separately and
destroy the tunnel with `proxy_tunnel_limit` after 128 MiB in either
direction. Reject the 33rd concurrent tunnel, close a tunnel after 60 seconds
without bytes, and enforce `min(privateRequestDeadline, now + 3600 seconds)`
as its absolute lifetime. Header parsing stops at 32 KiB; upstream response
headers stop at 64 KiB. Tests use fake clocks/sockets to prove each boundary,
client half-close, upstream half-close, cancellation, and slot release without
opening an external connection.

- [ ] **Step 5: Run focused security tests**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/network-policy.test.ts src/egress-proxy.test.ts`

Expected: PASS, including DNS rebinding, IPv6, metadata, CONNECT smuggling,
oversized headers, and proxy shutdown cases.

- [ ] **Step 6: Commit egress boundary**

Run: `git add apps/browser-service/src/network-policy.ts apps/browser-service/src/network-policy.test.ts apps/browser-service/src/egress-proxy.ts apps/browser-service/src/egress-proxy.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: enforce browser egress policy" -m "Validate every browser destination, reject internal address ranges, and
pin outbound connections to the DNS answer checked for each request.

Cover rebinding, alternate IP forms, CONNECT smuggling, and size limits."
```

### Task 3: Add immutable profile generations and session lifecycle

**Files:**
- Create: `apps/browser-service/src/profile-store.ts`
- Create: `apps/browser-service/src/profile-store.test.ts`
- Create: `apps/browser-service/src/session-registry.ts`
- Create: `apps/browser-service/src/session-registry.test.ts`

- [ ] **Step 1: Write profile atomicity and TTL tests**

```ts
test("publishes a writer generation atomically", async () => {
  const work = await store.createWorkingCopy(profileId, null, "writer", sessionId);
  await writeFile(join(work.path, "Cookies"), "state");
  const prepared = await store.prepareWorkingCopy(work);
  assert.equal(await store.hasCommitted(prepared.generationId), false);
  const generation = await store.finalizePreparedGeneration(prepared);
  assert.match(generation.generationId, UUID_RE);
  assert.equal(await readFile(join(store.generationPath(profileId, generation.generationId), "payload", "Cookies"), "utf8"), "state");
  assert.deepEqual(await store.listStaging(), []);
});

test("reconciles every profile crash boundary without advancing state", async () => {
  await store.reconcile({ referenced: priorReferences, now: clock.now() });
  assert.equal(await store.hasCommitted(orphanFinalizedId), false);
  assert.equal(await store.hasCommitted(latestReferencedId), true);
  assert.equal(await store.hasStaging(recentPreparedId), true);
  assert.deepEqual(store.corruptReferences, []);
});

test("expires on the first idle or absolute deadline", async () => {
  const session = await registry.create(baseRequest({ ttlSeconds: 60, activityTtlSeconds: 10 }));
  clock.advance(10_001);
  await registry.sweepExpired();
  assert.equal(registry.get(session.runtimeSessionId)?.state, undefined);
  assert.equal(onClosed.mock.calls[0][0].reason, "expired");
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/profile-store.test.ts src/session-registry.test.ts`

Expected: FAIL because profile store and registry do not exist.

- [ ] **Step 3: Add safe profile filesystem operations**

Use opaque UUIDs only. Derive paths internally:

```ts
generationPath(profileId, generationId) {
  assertUuid(profileId);
  assertUuid(generationId);
  return join(this.root, "committed", profileId, generationId);
}

async prepareWorkingCopy(work: WorkingCopy): Promise<PreparedGeneration> {
  if (work.mode !== "writer") throw runtimeError("profile_read_only", "Snapshot cannot publish changes");
  await fsyncTree(work.path);
  const generationId = randomUUID();
  const staging = join(this.root, "staging", `${generationId}.partial`);
  await mkdir(staging);
  await rename(work.path, join(staging, "payload"));
  const { checksum, sizeBytes } = await checksumTree(join(staging, "payload"));
  const prepareToken = randomBytes(32).toString("base64url");
  await writeManifestAndFsync(staging, {
    profileId: work.profileId, generationId, checksum, sizeBytes,
    prepareTokenHash: sha256(prepareToken), preparedAt: clock.now().toISOString(),
  });
  await fsyncDirectory(dirname(staging));
  return { profileId: work.profileId, generationId, prepareToken, checksum, sizeBytes };
}

async finalizePreparedGeneration(prepared: PreparedGeneration): Promise<CommittedGeneration> {
  const committed = this.generationPath(prepared.profileId, prepared.generationId);
  const staging = this.stagingPath(prepared.generationId);
  const manifest = await verifyManifestToken(staging, prepared.prepareToken);
  const verified = await checksumTree(join(staging, "payload"));
  if (verified.checksum !== prepared.checksum) throw runtimeError("profile_corrupt", "Prepared profile checksum changed");
  await rename(staging, committed);
  await fsyncDirectory(dirname(committed));
  return { profileId: prepared.profileId, generationId: prepared.generationId,
    checksum: manifest.checksum, sizeBytes: manifest.sizeBytes };
}
```

Close is a two-phase protocol. Chromium closes, then `prepareWorkingCopy()`
returns opaque generation metadata while the prior database pointer remains
authoritative. A separate idempotent private finalize request verifies the
token/checksum and renames staging to the immutable committed path. Only after
that succeeds may API insert generation metadata and advance
`latest_generation_id` in one transaction. Snapshot mode never prepares or
finalizes and deletes its working copy on close.

Do not delete all staging at process start. API startup first interrupts old
sessions, loads referenced generation IDs/checksums from PostgreSQL, then runs
profile reconciliation before browser readiness. Reconciliation validates
UUID-only directory shapes and:

- retains referenced committed generations and verifies their checksums;
- deletes finalized generations absent from PostgreSQL only after a 10-minute
  grace, covering a crash after finalize but before database commit;
- deletes prepared staging and abandoned work directories only after the same
  grace, covering a crash before finalize; and
- reports a missing or corrupt referenced generation as `profile_corrupt`,
  fails readiness, and never promotes an orphan or silently changes the
  database pointer.

An API database failure after finalize performs best-effort deletion of that
exact unreferenced generation; startup reconciliation is the durable fallback.
The finalize call and database insert are idempotent by generation UUID and
checksum so an unknown response can be retried safely.

- [ ] **Step 4: Add persistent Chromium registry**

Each session owns one `launchPersistentContext()` and one validating egress
proxy. Build options only from strict `replay.browserSettings` (or validated
direct-session defaults). Required replay launch shape:

```ts
const context = await chromium.launchPersistentContext(work.path, {
  headless: true,
  acceptDownloads: false,
  serviceWorkers: "block",
  viewport: {
    width: settings.viewport.width,
    height: settings.viewport.height,
  },
  deviceScaleFactor: settings.viewport.deviceScaleFactor,
  isMobile: settings.viewport.isMobile,
  hasTouch: settings.viewport.hasTouch,
  userAgent: settings.userAgent,
  locale: settings.locale,
  timezoneId: settings.timezoneId,
  geolocation: settings.geolocation,
  extraHTTPHeaders: settings.headers,
  ignoreHTTPSErrors: settings.skipTlsVerification,
  proxy: { server: egressProxy.url },
  args: [
    "--remote-debugging-port=0",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
  ],
});
```

Resolve `settings.proxy.credentialRef` only through a server-owned local proxy
record and never return secret material. Pass its upstream selection to the
validating egress proxy; if the referenced local selection is absent, return
`replay_unsupported` rather than silently use direct egress. `lockdown=true`
permits no new egress; `blockAds=true` applies the checked-in request-blocking
rules below the navigation policy. Direct sessions use the same schema with
explicit defaults. Tests assert every setting reaches context/proxy creation,
unknown device/timezone/proxy references fail closed, and no setting is read
from a public capability or model payload.

Registry record contains runtime/public IDs, state/version, page/context,
profile work, initial/allowed/learned origins, writer promise-chain, deadlines,
DevTools loopback endpoint, and stream hub. `withWriter()` serializes mutating
operations and rejects a second concurrent execution with
`concurrency_exceeded`. `touch()` moves only idle deadline. `close()` is
idempotent, closes Chromium before preparing a writer profile, and returns the
prepared generation metadata without publishing it.

For checkpoint replay, derive its path only from validated owner, scrape, and
checkpoint UUIDs under shared `LOCAL_BROWSER_STATE_ROOT`; never accept a path.
Read bounded JSON, verify SHA-256, require captured browser settings to match
the normalized envelope, call `context.setStorageState(parsedState)`, navigate
to recorded final URL, and compare the bounded title/body fingerprint. The
checkpoint's post-scrape cookies/storage are authoritative; envelope cookies
must match retained input policy but are not layered a second time. Any
mismatch closes session and returns `replay_unsupported` before execution.

- [ ] **Step 5: Run lifecycle tests**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/profile-store.test.ts src/session-registry.test.ts`

Expected: PASS for one writer, snapshot isolation, close idempotency, 10-minute
idle/60-minute absolute maxima, all prepare/finalize/database crash points,
orphan grace, corrupt-reference readiness failure, and prior-generation
retention.

- [ ] **Step 6: Commit profile lifecycle**

Run: `git add apps/browser-service/src/profile-store.ts apps/browser-service/src/profile-store.test.ts apps/browser-service/src/session-registry.ts apps/browser-service/src/session-registry.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: persist browser profile generations" -m "Create isolated Chromium working copies, publish writer generations
atomically, and keep read snapshots immutable.

Enforce session writer serialization and idle and absolute expiration."
```

### Task 4: Add typed operations and navigation-set enforcement

**Files:**
- Create: `apps/browser-service/src/evaluate-policy.ts`
- Create: `apps/browser-service/src/evaluate-policy.test.ts`
- Create: `apps/browser-service/src/operations.ts`
- Create: `apps/browser-service/src/operations.test.ts`
- Modify: `apps/browser-service/src/session-registry.ts`

- [ ] **Step 1: Write typed-operation security tests**

```ts
test("direct navigation requires an authorized domain", async () => {
  await assert.rejects(
    () => operations.execute(session, { kind: "navigate", url: "https://other.test/" }),
    error => hasCategory(error, "target_blocked"),
  );
});

test("clicked link and redirect add validated origins up to eight", async () => {
  await operations.execute(session, { kind: "click", ref: linkRef });
  assert.deepEqual(session.origins, ["https://start.test", "https://clicked.test"]);
  await assert.rejects(() => addNinthOrigin(session), /origin limit/i);
});

test("evaluate rejects network and dynamic-code primitives", () => {
  for (const expression of ["fetch(args.url)", "new WebSocket(args.url)", "eval(args.code)", "location.href=args.url"])
    assert.throws(() => validateEvaluateExpression(expression), /not allowed/i);
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/evaluate-policy.test.ts src/operations.test.ts`

Expected: FAIL because operation engine is absent.

- [ ] **Step 3: Add constrained evaluate policy**

Parse expressions with TypeScript's parser already available to the service
build. Accept one expression only. Reject assignments, update/new/import,
functions, classes, template tags, and identifiers `fetch`, `WebSocket`,
`XMLHttpRequest`, `EventSource`, `eval`, `Function`, `Worker`, `SharedWorker`,
`navigator`, `localStorage`, and `sessionStorage`. Permit reads/calls rooted at
`document`, `location`, or `args`, with an explicit member/call allowlist.

```ts
export function validateEvaluateExpression(source: string): void {
  const file = ts.createSourceFile("evaluate.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length || file.statements.length !== 1 ||
      !ts.isExpressionStatement(file.statements[0]!)) {
    throw runtimeError("capability_denied", "evaluate requires one expression");
  }
  visitEvaluateNode(file.statements[0]!.expression);
}
```

- [ ] **Step 4: Add stable snapshots and operation dispatch**

Snapshot creates a server-side `Map<string, Locator>` capped at 500 entries and
returns at most 64 KiB of role/name/text/value metadata. Clear references on
navigation. Do not inject reference attributes into the page.

```ts
export async function executeOperation(session: RuntimeSession, op: BrowserOperation) {
  return session.withWriter(async () => {
    session.assertReady();
    const result = await dispatch[op.kind](session, op as never);
    session.touch();
    return operationResultSchema.parse({
      kind: op.kind,
      data: result,
      page: { url: session.page.url(), title: await session.page.title() },
      sessionVersion: session.bumpVersion(),
    });
  });
}
```

Before `click`, inspect the referenced element's `href`/target. If it creates a
top-level navigation, validate and mark one pending clicked-link origin. Before
`navigate`, require hostname in caller `allowedDomains` or an existing origin.
Route every request with `serviceWorkers: "block"`: top-level redirects may add
one validated origin; ungranted scripted cross-origin navigations abort.
Subrequests may use other public origins but never enter navigation authority.
`page.on("download")` cancels downloads.

- [ ] **Step 5: Run operation and full service tests**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/evaluate-policy.test.ts src/operations.test.ts`

Expected: PASS for all 12 operations, stale refs, payload caps, redirects,
clicked links, direct grants, ninth-origin denial, subrequests, WebSockets,
downloads, and no automatic retry after action failure.

Run: `pnpm --dir apps/browser-service test`

Expected: all service tests PASS.

- [ ] **Step 6: Commit typed operations**

Run: `git add apps/browser-service/src/evaluate-policy.ts apps/browser-service/src/evaluate-policy.test.ts apps/browser-service/src/operations.ts apps/browser-service/src/operations.test.ts apps/browser-service/src/session-registry.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: add bounded browser operations" -m "Expose typed page actions with stable references, constrained evaluate,
payload limits, and serialized mutation.

Enforce validated navigation expansion, public subrequests, and
origin caps."
```

### Task 5: Serve authenticated sessions and private streams

**Files:**
- Create: `apps/browser-service/src/streams.ts`
- Create: `apps/browser-service/src/streams.test.ts`
- Create: `apps/browser-service/src/artifacts.ts`
- Create: `apps/browser-service/src/artifacts.test.ts`
- Create: `apps/browser-service/src/server.ts`
- Create: `apps/browser-service/src/server.test.ts`
- Create: `apps/browser-service/src/index.ts`
- Create: `apps/browser-service/Dockerfile`

- [ ] **Step 1: Write HTTP/WS contract tests**

```ts
test("unknown fields and missing service identity fail closed", async () => {
  const response = await request(app).post("/v1/sessions").send({ extra: true });
  assert.equal(response.status, 401);
});

test("passive stream rejects input while interactive accepts bounded input", async () => {
  const passive = await openStream("passive", validRelayGrant);
  passive.send(JSON.stringify({ kind: "pointer", x: 1, y: 1 }));
  assert.equal(await closeCode(passive), 1008);
  const interactive = await openStream("interactive", validRelayGrant);
  interactive.send(JSON.stringify({ kind: "pointer", x: 1, y: 1, button: "left" }));
  assert.equal(await nextAck(interactive), "ok");
});

test("CDP holds the writer lease and rejects administrative commands", async () => {
  const cdp = await openStream("cdp", validRelayGrant);
  await assert.rejects(() => operations.click(session, ref), /concurrency_exceeded/);
  cdp.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  assert.deepEqual(await nextCdpError(cdp), {
    id: 1,
    error: { code: -32000, message: "CDP command is not permitted" },
  });
});

test("artifact capture is explicit and bounded", async () => {
  const artifact = await captureArtifact(session, {
    kind: "screenshot", format: "png", fullPage: false,
  });
  assert.equal(artifact.contentType, "image/png");
  assert.ok(artifact.byteSize <= 16 * 1024 * 1024);
  assert.equal(artifact.checksum.length, 64);
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/streams.test.ts src/server.test.ts`

Expected: FAIL because service routes do not exist.

- [ ] **Step 3: Add stream hub and relay grants**

Use `Page.startScreencast` through `context.newCDPSession(page)`. Cap frames at
1280x720 JPEG/70 and 10 fps; acknowledge each frame. Interactive messages are
a strict union of pointer, wheel, key, and text events, max 4 KiB. Serialize
input through the session writer lease. A service relay grant binds session,
permission, expiry, and one concurrent connection. Store only its SHA-256 hash.
CDP never blindly pipes bytes. Its relay holds the same session writer lease
for the full connection, caps a frame at 256 KiB and 64 outstanding command
IDs, parses one JSON object per frame, and releases the lease on close,
deadline, or cancellation. Reject binary, batch, malformed, duplicate-ID, and
unsolicited client response frames.

Reject administrative CDP methods `Browser.close`,
`Browser.setDownloadBehavior`, `Browser.grantPermissions`,
`Browser.resetPermissions`, `Security.setIgnoreCertificateErrors`,
`Target.createBrowserContext`, `Target.disposeBrowserContext`,
`Target.createTarget`, and `Target.closeTarget`. Validate URL-bearing
`Page.navigate` and `Target.activateTarget` requests against the session-owned
target and navigation policy before forwarding. The permanent context route
and validating egress proxy remain active beneath CDP, including for
`Runtime.evaluate` network attempts. Never expose the loopback DevTools
endpoint. Tests prove a second typed operation, interactive stream, or CDP
connection receives `concurrency_exceeded`; forbidden commands return a
sanitized CDP error without closing Chromium; disconnect releases the lease.

`artifacts.ts` accepts only authenticated internal screenshot, bounded trace,
or recording requests; it is not an MCP operation. Screenshot input is strict
`{kind:"screenshot",format:"png"|"jpeg",fullPage:boolean,quality?}`. Trace and
recording inputs select only a checked-in preset. Capture runs under the
session writer lease, rejects downloads, returns a stream plus
`{artifactId,kind,contentType,byteSize,checksum}`, caps one object at 16 MiB,
eight objects and 32 MiB per run, and deletes temporary files after stream
close. No response contains a filesystem path. Tests cover size/count budgets,
checksum mismatch, disconnect cleanup, and disabled/ZDR rejection.

- [ ] **Step 4: Add authenticated routes and ordered shutdown**

```ts
app.post("/v1/sessions", privateRequest, asyncRoute(async (req, res) => {
  const input = createSessionRequestSchema.parse(req.body);
  const session = await registry.create(input, req.privateContext);
  res.status(201).json(toCreateResponse(session));
}));

app.post("/v1/sessions/:id/operations", privateRequest, asyncRoute(async (req, res) => {
  const input = operationRequestSchema.parse(req.body);
  res.json(await registry.execute(req.params.id, input, req.privateContext));
}));

app.delete("/v1/sessions/:id", privateRequest, asyncRoute(async (req, res) => {
  const input = closeSessionRequestSchema.parse(req.body);
  res.json(await registry.close(req.params.id, input.reason, input.saveProfile));
}));
```

Add state query, grant create/revoke, `health/live`, `health/ready`, and an
authenticated disposable `health/session`. Add idempotent typed
`POST /v1/profile-generations/:id/finalize` and
`DELETE /v1/profile-generations/:id` routes; both require profile ID,
generation ID, checksum, and the opaque prepare token returned by close, and
neither accepts a filesystem path. Upgrade handler authenticates the
service identity plus relay grant before selecting passive/interactive/CDP.
Add authenticated `POST /v1/sessions/:id/artifacts`; it accepts the strict
capture schema plus server-issued run ID/deadline, streams one bounded object,
and never stores it locally after completion.
SIGTERM stops accepting creates, closes streams, closes sessions with bounded
profile save, then closes server and sweep timer.

- [ ] **Step 5: Add container image**

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /var/lib/firecrawl-browser/profiles && \
    chown -R pwuser:pwuser /app /var/lib/firecrawl-browser
USER pwuser
CMD ["node", "dist/index.js"]
```

- [ ] **Step 6: Run contract tests and image build**

Run:
`pnpm --dir apps/browser-service exec node --import tsx --test src/streams.test.ts src/artifacts.test.ts src/server.test.ts`

Expected: PASS.

Run: `docker build -t firecrawl-local-browser-service:test apps/browser-service`

Expected: image builds and runs as `pwuser`.

- [ ] **Step 7: Commit service transport**

Run: `git add apps/browser-service/src/streams.ts apps/browser-service/src/streams.test.ts apps/browser-service/src/artifacts.ts apps/browser-service/src/artifacts.test.ts apps/browser-service/src/server.ts apps/browser-service/src/server.test.ts apps/browser-service/src/index.ts apps/browser-service/Dockerfile`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: serve private browser sessions" -m "Add authenticated session, operation, grant, health, live-view, and CDP
transports around persistent Chromium runtimes.

Close streams and sessions in order during service shutdown."
```

### Task 6: Add typed API client and local feature gate

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/lib/local-runtime-config.ts`
- Modify: `apps/api/src/lib/local-runtime-config.test.ts`
- Modify: `apps/api/src/lib/scrape-interact/browser-service-client.ts`
- Create: `apps/api/src/lib/scrape-interact/browser-service-client.test.ts`

- [ ] **Step 1: Write fail-closed config and client tests**

```ts
it("requires service URL and key when local browser is enabled", () => {
  expect(() => resolveLocalRuntimeConfig(enabledBase({
    LOCAL_BROWSER_SERVICE_ENABLED: true,
    BROWSER_SERVICE_URL: undefined,
    BROWSER_SERVICE_API_KEY: undefined,
  }))).toThrow(/BROWSER_SERVICE_URL.*BROWSER_SERVICE_API_KEY/s);
});

it("sends correlation, absolute deadline, auth, and abort signal", async () => {
  await client.createSession(createInput, { correlationId, deadline, signal });
  expect(fetchMock).toHaveBeenCalledWith("http://browser-service:3010/v1/sessions",
    expect.objectContaining({ signal, headers: expect.objectContaining({
      authorization: "Bearer secret",
      "x-firecrawl-correlation-id": correlationId,
      "x-firecrawl-deadline": deadline.toISOString(),
    }) }));
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/api exec vitest run src/lib/local-runtime-config.test.ts src/lib/scrape-interact/browser-service-client.test.ts`

Expected: FAIL because flag validation and typed client are absent.

- [ ] **Step 3: Add local config gate**

Add:

```ts
LOCAL_BROWSER_SERVICE_ENABLED: z.stringbool().default(false),
BROWSER_SERVICE_URL: emptyStringAsUndefined(z.string().url()),
BROWSER_SERVICE_API_KEY: emptyStringAsUndefined(z.string().min(32)),
BROWSER_SERVICE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
BROWSER_ADAPTER_TOKEN_FILE: emptyStringAsUndefined(z.string()),
```

When local browser is enabled, require local persistence, URL, and key. Reject
non-HTTP service URLs. If an adapter token-file path is present, require it to
be absolute. Do not require that file until host execution replaces the
fail-closed adapter, infer cloud defaults, or accept an API key from a public
request.

- [ ] **Step 4: Replace loose method/path helper with typed methods**

```ts
export class BrowserServiceClient {
  createSession(input: CreateSessionInput, ctx: RequestContext) {
    return this.request(createSessionResponseSchema, "POST", "/v1/sessions", input, ctx);
  }
  executeOperation(runtimeId: string, input: OperationInput, ctx: RequestContext) {
    return this.request(operationResponseSchema, "POST",
      `/v1/sessions/${encodeURIComponent(runtimeId)}/operations`, input, ctx);
  }
  createRelayGrant(runtimeId: string, input: RelayGrantInput, ctx: RequestContext) {
    return this.request(relayGrantResponseSchema, "POST",
      `/v1/sessions/${encodeURIComponent(runtimeId)}/grants`, input, ctx);
  }
  closeSession(runtimeId: string, input: CloseInput, ctx: RequestContext) {
    return this.request(closeResponseSchema, "DELETE",
      `/v1/sessions/${encodeURIComponent(runtimeId)}`, input, ctx);
  }
  finalizeProfileGeneration(input: FinalizeGenerationInput, ctx: RequestContext) {
    return this.request(committedGenerationSchema, "POST",
      `/v1/profile-generations/${encodeURIComponent(input.generationId)}/finalize`, input, ctx);
  }
  discardProfileGeneration(input: DiscardGenerationInput, ctx: RequestContext) {
    return this.request(discardGenerationResponseSchema, "DELETE",
      `/v1/profile-generations/${encodeURIComponent(input.generationId)}`, input, ctx);
  }
}
```

Use `AbortSignal.any([ctx.signal, AbortSignal.timeout(limit)])`. Parse success
and typed error bodies with Zod. Convert transport, timeout, and category errors
to `BrowserServiceError` without embedding response bodies or private URLs.
No generic caller-supplied method or path remains.

- [ ] **Step 5: Run tests and API build**

Run:
`pnpm --dir apps/api exec vitest run src/lib/local-runtime-config.test.ts src/lib/scrape-interact/browser-service-client.test.ts`

Expected: PASS.

Run: `pnpm --dir apps/api build`

Expected: PASS.

- [ ] **Step 6: Commit client and gate**

Run: `git add apps/api/src/config.ts apps/api/src/lib/local-runtime-config.ts apps/api/src/lib/local-runtime-config.test.ts apps/api/src/lib/scrape-interact/browser-service-client.ts apps/api/src/lib/scrape-interact/browser-service-client.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: gate the local browser runtime" -m "Require explicit local Browser Service configuration and replace its
loose request helper with typed deadline-aware client methods.

Map service failures without leaking private endpoints or response
bodies."
```

### Task 7: Coordinate durable sessions, replay, profiles, and stop

**Files:**
- Create: `apps/api/src/lib/browser-runtime/orchestrator.ts`
- Create: `apps/api/src/lib/browser-runtime/orchestrator.test.ts`
- Create: `apps/api/src/lib/browser-runtime/execution-adapter.ts`
- Create: `apps/api/src/lib/browser-runtime/execution-adapter.test.ts`
- Create: `apps/api/src/controllers/internal/browser-runs.ts`
- Create: `apps/api/src/controllers/internal/browser-runs.test.ts`
- Create: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/browser-state/store.ts`
- Create: `apps/api/src/lib/browser-state/capability-store.ts`
- Create: `apps/api/src/lib/browser-state/capability-store.test.ts`
- Create: `apps/api/src/lib/browser-state/proxy-grant-store.ts`
- Create: `apps/api/src/lib/browser-state/proxy-grant-store.test.ts`
- Create: `apps/api/src/lib/browser-runtime/artifacts.ts`
- Create: `apps/api/src/lib/browser-runtime/artifacts.test.ts`
- Modify: `apps/api/src/lib/artifacts/manifest.ts`
- Modify: `apps/api/src/lib/artifacts/local-manifest.ts`

- [ ] **Step 1: Write orchestration race tests**

```ts
it("creates Browser Service only after durable session and profile lease", async () => {
  await orchestrator.createInteractSession(input);
  expect(calls).toEqual([
    "createBrowserSession", "acquireProfileWriter", "service.createSession",
    "attachRuntime", "session.replaying", "session.ready",
  ]);
});

it("fails closed when no host execution adapter is installed", async () => {
  await expect(unavailableExecutionAdapter.executePromptRun(promptInput, signal))
    .rejects.toMatchObject({ category: "codex_unavailable" });
  await expect(unavailableExecutionAdapter.executeCodeRun(codeInput, signal))
    .rejects.toMatchObject({ category: "sandbox_unavailable" });
});

it("stop has one cleanup owner and is idempotent", async () => {
  const [a, b] = await Promise.all([
    orchestrator.stopSession(sessionId, "requested"),
    orchestrator.stopSession(sessionId, "requested"),
  ]);
  expect([a.cleanupOwner, b.cleanupOwner].filter(Boolean)).toHaveLength(1);
  expect(service.closeSession).toHaveBeenCalledTimes(1);
  expect(revokeSessionProxyGrants).toHaveBeenCalledTimes(1);
});

it("adapter callback resolves authority without accepting a capability", async () => {
  const response = await invokeAdapterOperation(runId, {
    sequence: 1,
    operation: { kind: "get_url" },
  });
  expect(redeemBrowserCapability).toHaveBeenCalledWith(
    expect.objectContaining({ runId, operation: "get_url" }),
  );
  expect(response.statusCode).toBe(200);
});

it("stores one bounded browser artifact under the durable run prefix", async () => {
  await ingestBrowserArtifact(run, streamedPng);
  expect(putLocalArtifactWithManifest).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      key: expect.stringContaining(`/sessions/${run.sessionId}/runs/${run.id}/`),
      ownerId: run.ownerId, requestId: run.requestId, jobId: run.id,
    }),
  );
  expect(attachRunArtifact).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/api exec vitest run src/lib/browser-runtime/orchestrator.test.ts`

Expected: FAIL because coordinator is absent.

- [ ] **Step 3: Define injectable host execution boundary**

```ts
export type PromptRunInput = {
  runId: string;
  runtimeSessionId: string;
  prompt: string;
  model: "gpt-5.6-terra";
  reasoningEffort: "medium";
  deadline: Date;
  correlationId: string;
};
export type PromptRunResult = {
  output: string;
  usage: { inputTokens: number; outputTokens: number };
};
export type CodeRunInput = {
  runId: string;
  runtimeSessionId: string;
  language: "node" | "python" | "bash";
  source: string;
  deadline: Date;
  correlationId: string;
};
export type CodeRunResult = {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
};

export interface ExecutionAdapter {
  executePromptRun(input: PromptRunInput, signal: AbortSignal): Promise<PromptRunResult>;
  executeCodeRun(input: CodeRunInput, signal: AbortSignal): Promise<CodeRunResult>;
  cancelExecutionRun(runId: string, reason: string): Promise<void>;
}

export const unavailableExecutionAdapter: ExecutionAdapter = {
  async executePromptRun() {
    throw new BrowserRuntimeError("codex_unavailable", "Local Codex adapter is unavailable");
  },
  async executeCodeRun() {
    throw new BrowserRuntimeError("sandbox_unavailable", "Local code sandbox is unavailable");
  },
  async cancelExecutionRun() {},
};
```

`createBrowserRuntimeOrchestrator(deps)` accepts this interface. Production
uses unavailable default until host plan supplies client. Tests inject a fake;
no test-only global setter or environment branch.

- [ ] **Step 4: Add missing compare-and-set state helpers**

Extend foundation store with exact helpers:

```ts
attachBrowserRuntime(sessionId, expectedState, runtimeSessionId, deadline)
listBrowserSessions(ownerId, status?)
claimBrowserSessionStop(sessionId, allowedStates, reason)
finishBrowserSessionStop(sessionId, terminalState, generationId, reason)
```

Extend `store.ts` with `getProfileGeneration()` and
`commitProfileGeneration()`. Commit advances pointer and releases writer lease
in one transaction. Add capability/grant stores with exact exports:

```ts
issueBrowserCapability(input)
redeemBrowserCapability(input)
consumeBrowserCapabilityBudget(input)
revokeRunCapabilities(runId, reason)
issueBrowserProxyGrant(input)
redeemBrowserProxyGrant(input)
revokeSessionProxyGrants(sessionId, reason)
```

Raw tokens are returned only once from issue functions and only SHA-256 hashes
are stored. Redeem and budget updates are atomic. All state changes use
compare-and-set, not read-then-write.

- [ ] **Step 5: Add coordinator create/execute/stop flow**

```ts
export async function createInteractSession(input: CreateInteractSessionInput) {
  const durable = await createBrowserSession({
    ownerId: input.ownerId, scrapeId: input.scrapeId,
    ttlSeconds: 3600, activityTtlSeconds: 600, state: "creating",
  });
  const profile = await prepareProfileLease(input.ownerId, input.profile, durable.id);
  try {
    const runtime = await browserClient.createSession(toServiceCreate(durable, profile, input.replay), input.context);
    await attachBrowserRuntime(durable.id, "creating", runtime.runtimeSessionId, input.context.deadline);
    await transitionAndReplay(durable.id, runtime.runtimeSessionId, input.replay, input.context);
    return await getBrowserSession(durable.id);
  } catch (error) {
    await cleanupFailedCreate(durable, profile, error);
    throw error;
  }
}
```

Direct sessions use caller TTL defaults 600/300 and normalize
`activityTtl <= ttl`. Interact always uses 3600/600 and reserves that lifetime.
Replay sends normalized checkpoint, never generated raw JavaScript.
`stopSession` claims cleanup, cancels adapter run, revokes capabilities/proxy
grants, and closes the service session. For a writer, close returns a prepared
generation; API finalizes it through the typed client, verifies the returned
UUID/checksum, then transactionally inserts metadata, advances the profile
pointer, releases slot/lease, and persists one terminal result. Database
failure leaves the prior pointer authoritative and triggers exact-generation
best-effort discard. Startup reconciliation removes any finalized orphan after
the grace window. Service unavailable still records terminal/interrupted state
and leaves the previous generation authoritative.

- [ ] **Step 6: Add adapter-only operation and CDP callbacks**

Create an internal router mounted at `/internal`. Authenticate from
`BROWSER_ADAPTER_TOKEN_FILE`, which host operations generates per boot and
bind-mounts read-only into API and adapter. Compare token hashes in constant
time. Until the host plan enables execution, an absent token keeps these
routes closed with typed `adapter_unavailable`; it must not prevent direct
create/list/delete or Browser Service acceptance.

```ts
internalRouter.post(
  "/browser-runs/:runId/operations",
  requireAdapterToken,
  wrap(browserRunOperationController),
);
internalRouter.ws(
  "/browser-runs/:runId/cdp",
  requireAdapterTokenWs,
  browserRunCdpController,
);
internalRouter.post(
  "/browser-runs/:runId/artifacts",
  requireAdapterToken,
  wrap(browserRunArtifactController),
);
```

Operation body is strict `{ sequence, operation }`; it cannot contain owner,
session, capability, model, path, URL grant, command, environment, or mount.
Controller loads active run, resolves server-held capability, consumes its
operation/call/byte/deadline budget, and invokes Browser Service. Enforce a
monotonic sequence per run so adapter retries cannot duplicate an action. A
failed model-generated action is returned once and never replayed.

CDP callback validates an active code run, creates a one-use private Browser
Service `cdp` relay, and proxies bytes with bounds/cancellation. Code runner
sees only its per-job adapter UDS. Codex/runner never receives API token,
capability, Browser Service key, private endpoint, or public proxy token.

`artifacts.ts` validates an active non-ZDR run, owner/request/scrape/session
bindings, declared type/size/SHA-256, per-item 16 MiB and per-run eight-object/
32 MiB budgets, and content types `image/png`, `image/jpeg`,
`application/json`, `application/zip`, and `text/plain`. It rejects an absent
or oversized `Content-Length`, reads the exact body into one capped 16 MiB
buffer while hashing incrementally, then calls
`putLocalArtifactWithManifest()` under exactly
`owners/<owner>/requests/<request>/scrapes/<scrape>/sessions/<session>/runs/<run>/<artifact>`;
`<scrape>` is its UUID or the literal `direct` for direct Browser sessions;
all other IDs are UUIDs and extension comes from the allowlisted content type. Manifest
uses `requestId`, `jobId=runId`, kind, checksum metadata, and parent request
retention. After the object/manifest transaction, append the validated
reference to `browser_interact_runs.artifact_references` with compare-and-set.
If that update fails, leave the manifest for normal retention and return a
typed persistence error; never return an unreferenced object to a caller.
Map references to the existing bounded Interact artifact response shape and
never expose object-store credentials or raw internal keys as public URLs.
Extend `ArtifactManifestRecord`/`ManifestArtifactInput` with optional checksum
for backward compatibility and persist it in migration 0004's nullable
`local_artifacts.checksum`; browser ingestion always supplies and verifies it.
Adapter upload uses `Content-Type: application/octet-stream`, exact
`Content-Length`, and strict `X-Firecrawl-Artifact-Id`, `-Kind`,
`-Content-Type`, `-Byte-Size`, and `-Sha256` headers; unknown/duplicate headers
in this namespace, chunked bodies, early EOF, trailing bytes, or digest
mismatch are rejected before a run reference is attached.

- [ ] **Step 7: Run orchestration and callback tests**

Run:
`pnpm --dir apps/api exec vitest run src/lib/browser-runtime/orchestrator.test.ts src/lib/browser-runtime/execution-adapter.test.ts src/lib/browser-runtime/artifacts.test.ts src/controllers/internal/browser-runs.test.ts src/lib/browser-state`

Expected: PASS for create rollback, profile lock, replay failure, duplicate
stop, execution/stop race, profile commit failure, service restart, bad adapter
token, stale sequence, budget exhaustion, callback cancellation, crash before
profile finalize, crash after finalize but before database commit, idempotent
finalize retry, corrupt referenced generation readiness failure, artifact
budget/checksum/ZDR rejection, manifest rollback, and response mapping.

- [ ] **Step 8: Commit orchestration**

Run: `git add apps/api/src/lib/browser-runtime/orchestrator.ts apps/api/src/lib/browser-runtime/orchestrator.test.ts apps/api/src/lib/browser-runtime/execution-adapter.ts apps/api/src/lib/browser-runtime/execution-adapter.test.ts apps/api/src/lib/browser-runtime/artifacts.ts apps/api/src/lib/browser-runtime/artifacts.test.ts apps/api/src/lib/artifacts/manifest.ts apps/api/src/lib/artifacts/local-manifest.ts apps/api/src/controllers/internal/browser-runs.ts apps/api/src/controllers/internal/browser-runs.test.ts apps/api/src/routes/internal.ts apps/api/src/index.ts apps/api/src/lib/browser-state/store.ts apps/api/src/lib/browser-state/capability-store.ts apps/api/src/lib/browser-state/capability-store.test.ts apps/api/src/lib/browser-state/proxy-grant-store.ts apps/api/src/lib/browser-state/proxy-grant-store.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: coordinate durable browser sessions" -m "Bind database state, profile leases, replay, Browser Service lifecycle,
adapter cancellation and terminal cleanup through compare-and-set
updates.

Make duplicate stop and cleanup races resolve to one durable owner."
```

### Task 8: Preserve direct Browser API through local runtime

**Files:**
- Modify: `apps/api/src/controllers/v2/browser.ts`
- Create: `apps/api/src/controllers/v2/browser.test.ts`
- Create: `apps/api/src/lib/browser-runtime/proxy-urls.ts`
- Create: `apps/api/src/lib/browser-runtime/proxy-urls.test.ts`

- [ ] **Step 1: Write controller compatibility tests**

```ts
it("normalizes direct defaults and returns only opaque API URLs", async () => {
  const response = await invokeCreate({});
  expect(orchestrator.createDirectSession).toHaveBeenCalledWith(expect.objectContaining({
    ttlSeconds: 600, activityTtlSeconds: 300,
  }));
  expect(response.body.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:3002\/v2\/browser\/proxy\//);
  expect(JSON.stringify(response.body)).not.toContain("browser-service");
});

it("requires allowedDomains before direct code can navigate", async () => {
  const response = await invokeExecute({
    code: "await page.goto('https://example.com')",
    language: "node",
    allowedDomains: [],
  });
  expect(response.statusCode).toBe(403);
  expect(response.body.error).toMatch(/target is not allowed/i);
});

it("returns typed 503 when code adapter is not installed", async () => {
  const response = await invokeExecute({
    code: "console.log(await page.title())",
    language: "node",
    allowedDomains: ["example.com"],
  });
  expect(response.statusCode).toBe(503);
  expect(response.body.error).toMatch(/sandbox.*unavailable/i);
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/api exec vitest run src/controllers/v2/browser.test.ts src/lib/browser-runtime/proxy-urls.test.ts`

Expected: FAIL because controller still returns Browser Service endpoints.

- [ ] **Step 3: Add domain validation and opaque URL minting**

Extend execute schema with:

```ts
allowedDomains: z.array(z.string().min(1).max(253)).max(8).default([]),
```

Normalize with `domainToASCII`, lowercase, strip one trailing dot, reject URL
syntax, ports, wildcards, credentials, localhost, and IP literals. Union with
session origins must remain at most 8.

`mintBrowserProxyUrls()` issues separate `passive`, `interactive`, and `cdp`
records through `issueBrowserProxyGrant`. Return only:

```ts
{
  liveViewUrl: `${publicBase}/v2/browser/proxy/${passiveToken}/view`,
  interactiveLiveViewUrl: `${publicBase}/v2/browser/proxy/${interactiveToken}/view`,
  cdpUrl: `${publicWsBase}/v2/browser/proxy/${cdpToken}/cdp`,
}
```

Tokens have 5-minute expiry, hashes only in PostgreSQL, one concurrent stream,
and session/owner/permission binding.

- [ ] **Step 4: Refactor direct controllers**

Delete duplicate private request/types from `browser.ts`. Create/list/execute/
delete call orchestrator and foundation state helpers. List mints fresh proxy
URLs and never returns stored backend URLs. Execute creates a durable code run,
passes validated domains to injected execution adapter, and persists activity/
exit metadata when an adapter exists. Unavailable default returns typed 503 and
marks run failed without destroying ready browser. Delete calls idempotent stop;
webhook remains only for hosted flag-off behavior.

- [ ] **Step 5: Run controller tests**

Run:
`pnpm --dir apps/api exec vitest run src/controllers/v2/browser.test.ts src/lib/browser-runtime/proxy-urls.test.ts`

Expected: PASS for defaults, shorter TTL, maxima, `activityTtl <= ttl`, profile
409, cross-owner 403, expired 410, domains, list URL rotation, unavailable
adapter 503, fake-adapter result mapping, and idempotent delete.

- [ ] **Step 6: Commit direct API integration**

Run: `git add apps/api/src/controllers/v2/browser.ts apps/api/src/controllers/v2/browser.test.ts apps/api/src/lib/browser-runtime/proxy-urls.ts apps/api/src/lib/browser-runtime/proxy-urls.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: route browser API through local runtime" -m "Preserve direct Browser create, list, execute, and delete responses
while using durable sessions and an injectable execution boundary.

Return rotating API proxy URLs and fail closed until host execution
exists."
```

### Task 9: Connect scrape Interact and terminal stop

**Files:**
- Modify: `apps/api/src/controllers/v2/scrape-browser.ts`
- Create: `apps/api/src/controllers/v2/scrape-browser.test.ts`
- Modify: `apps/api/src/lib/scrape-interact/browser-agent.ts`
- Modify: `apps/api/src/__tests__/snips/v2/scrape-browser.test.ts`

- [ ] **Step 1: Write controller tests for local prompt/code and stop**

```ts
it("uses 3600/600 and submits one request to injected prompt adapter", async () => {
  await invokeInteract({ prompt: "Read the heading", timeout: 60 });
  expect(orchestrator.createInteractSession).toHaveBeenCalledWith(expect.objectContaining({
    ttlSeconds: 3600, activityTtlSeconds: 600,
  }));
  expect(executePromptRun).toHaveBeenCalledTimes(1);
  expect(executePromptRun).toHaveBeenCalledWith(expect.objectContaining({
    model: "gpt-5.6-terra", reasoningEffort: "medium",
  }), expect.any(AbortSignal));
});

it("DELETE cancels the active run and is idempotent", async () => {
  const first = await invokeStop(scrapeId);
  const second = await invokeStop(scrapeId);
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(cancelExecutionRun).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/api exec vitest run src/controllers/v2/scrape-browser.test.ts src/__tests__/snips/v2/scrape-browser.test.ts`

Expected: local-runtime cases FAIL because controller uses legacy replay script
and Gemini agent loop.

- [ ] **Step 3: Replace legacy local Interact flow**

Schema must enforce XOR, not merely at least one:

```ts
.refine(value => Number(Boolean(value.code)) + Number(Boolean(value.prompt)) === 1,
  { message: "Exactly one of 'code' or 'prompt' must be provided." })
```

Add `allowedDomains`. Before creating state, load owned scrape and
`loadScrapeReplayState()`. ZDR or unsupported replay returns typed 409. Reuse
only an owned `ready` session. Otherwise create with checkpoint replay and
3600/600. Prompt path issues browser capability, creates durable run, marks
prompt usage in PostgreSQL, calls adapter once, revokes capability in `finally`,
and persists terminal state. Code path calls the same injected boundary. Fake
unit adapters return existing output/stdout/result/stderr/exit fields plus proxy
URLs. Production unavailable adapter returns typed 503 until host plan lands.

Keep old hosted path only when `LOCAL_BROWSER_SERVICE_ENABLED=false`.
`browser-agent.ts` must not import Gemini on local path; delete local Gemini
selection and any local cloud fallback branch.

- [ ] **Step 4: Make scrape stop terminal and idempotent**

Look up latest owned session including terminal state. A missing scrape remains
404; a scrape with no session returns 200 success. An active session calls
orchestrator stop. Terminal session immediately returns its persisted duration
and billing once. Never recreate a session during DELETE.

- [ ] **Step 5: Run focused Interact tests**

Run:
`pnpm --dir apps/api exec vitest run src/controllers/v2/scrape-browser.test.ts src/__tests__/snips/v2/scrape-browser.test.ts`

Expected: PASS for prompt/code XOR, ownership, ZDR, checkpoint failure, session
reuse, allowed domains, one fake-adapter call, unavailable 503, activity records,
and duplicate stop.

- [ ] **Step 6: Commit Interact integration**

Run: `git add apps/api/src/controllers/v2/scrape-browser.ts apps/api/src/controllers/v2/scrape-browser.test.ts apps/api/src/lib/scrape-interact/browser-agent.ts apps/api/src/__tests__/snips/v2/scrape-browser.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: run scrape interact on local browsers" -m "Restore retained scrape checkpoints into durable local sessions and
route prompt or code runs through an injectable execution boundary.

Make stop terminal and idempotent without Gemini or cloud fallback."
```

### Task 10: Proxy live view and CDP through API

**Files:**
- Create: `apps/api/src/controllers/v2/browser-proxy.ts`
- Create: `apps/api/src/controllers/v2/browser-proxy.test.ts`
- Modify: `apps/api/src/routes/v2.ts`

- [ ] **Step 1: Write proxy permission and revocation tests**

```ts
it("serves no-store viewer with restrictive browser headers", async () => {
  const response = await request(app).get(`/v2/browser/proxy/${passiveToken}/view`);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
});

it("passive cannot open interactive or CDP upstream", async () => {
  await expect(openProxy(passiveToken, "interactive")).rejects.toMatchObject({ code: 1008 });
  await expect(openProxy(passiveToken, "cdp")).rejects.toMatchObject({ code: 1008 });
});
```

- [ ] **Step 2: Run tests and confirm red state**

Run:
`pnpm --dir apps/api exec vitest run src/controllers/v2/browser-proxy.test.ts`

Expected: FAIL because proxy routes do not exist.

- [ ] **Step 3: Add minimal viewer**

Serve fixed HTML, no user/page interpolation. Viewer opens a same-token `/ws`
URL, decodes bounded frame messages into canvas, and sends no input in passive
mode. Interactive mode sends normalized pointer/key events only. Headers:

```ts
res.set({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src data:; frame-ancestors 'none'",
});
```

Put static JS/CSS on same-origin fixed routes; do not use inline script so CSP
needs no nonce/token interpolation.

- [ ] **Step 4: Add WebSocket relay**

Register HTTP viewer before token-free WS routes:

```ts
v2Router.get("/browser/proxy/:token/view", wrap(browserProxyViewController));
v2Router.ws("/browser/proxy/:token/ws", browserProxyLiveWsController);
v2Router.ws("/browser/proxy/:token/cdp", browserProxyCdpWsController);
```

Hash token, atomically redeem through `redeemBrowserProxyGrant`, confirm grant
permission/session state/expiry/use count, then ask Browser Service for a
single-use relay grant. Connect to private stream with service identity. Apply
64 KiB message caps and backpressure; propagate close, client abort, stop, and
deadline both ways. Reject Origin not matching configured API origin for view
streams. CDP clients may omit Origin but require `cdp` grant. Never log token,
private URL, CDP payload, or page input.

- [ ] **Step 5: Run proxy and route tests**

Run:
`pnpm --dir apps/api exec vitest run src/controllers/v2/browser-proxy.test.ts`

Expected: PASS for passive/interactive/CDP separation, expiry, replay, owner
binding, revocation on stop, origin/CSRF, message bounds, and backpressure.

- [ ] **Step 6: Commit API proxy**

Run: `git add apps/api/src/controllers/v2/browser-proxy.ts apps/api/src/controllers/v2/browser-proxy.test.ts apps/api/src/routes/v2.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: proxy browser streams through API" -m "Redeem owner-bound grants and relay passive, interactive, and CDP
streams without exposing Browser Service addresses.

Add no-store viewer headers, origin checks, bounds, and revocation."
```

### Task 11: Wire private Compose service behind disabled flag

**Files:**
- Modify: `compose.local.yaml`
- Modify: `.env.example.local`

- [ ] **Step 1: Add Browser Service and profile volume**

```yaml
services:
  browser-service:
    build: apps/browser-service
    image: firecrawl-local-browser-service:local
    restart: unless-stopped
    networks: [backend]
    environment:
      PORT: "3010"
      BROWSER_SERVICE_API_KEY: ${BROWSER_SERVICE_API_KEY}
      BROWSER_PROFILE_ROOT: /var/lib/firecrawl-browser/profiles
      MAX_BROWSER_SESSIONS: ${MAX_BROWSER_SESSIONS:-4}
    volumes:
      - browser-state:/var/lib/firecrawl-browser
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3010/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    cpus: 2.0
    mem_limit: 4G
    memswap_limit: 4G
    tmpfs:
      - /tmp:noexec,nosuid,size=1g
```

API environment:

```yaml
LOCAL_BROWSER_SERVICE_ENABLED: ${LOCAL_BROWSER_SERVICE_ENABLED:-false}
BROWSER_SERVICE_URL: http://browser-service:3010
BROWSER_SERVICE_API_KEY: ${BROWSER_SERVICE_API_KEY}
```

Reuse the state plan's `browser-state` volume so API retention can verify and
delete profile generations; do not declare a second profile volume. Add healthy
dependency only when local deployment owns service. Publish no Browser Service
port. Do not mount an adapter token yet; the host plan owns that boundary.
`.env.example.local` documents flag false, a generated 32+ byte key example,
and max sessions. Do not touch real `.env`.

- [ ] **Step 2: Validate Compose and port policy**

Run: `docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet`

Expected: exit 0.

Run: `docker compose --project-name firecrawl --project-directory . -f compose.yaml config`

Expected: `browser-service` has no `ports`; only API publishes
`127.0.0.1:3002`.

- [ ] **Step 3: Build and run Browser Service tests**

Run: `docker compose --project-name firecrawl --project-directory . -f compose.yaml build browser-service`

Expected: exit 0.

Run: `pnpm --dir apps/browser-service test`

Expected: all service tests PASS.

- [ ] **Step 4: Commit Compose wiring**

Run: `git add compose.local.yaml .env.example.local`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "feat: add private browser service runtime" -m "Build and run Browser Service on the backend network with a durable
profile volume, bounded resources, and no published port.

Keep local Browser and Interact disabled until acceptance gates pass."
```

### Task 12: Add direct Browser and security snips

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/harness.ts`
- Create: `apps/api/src/harness-browser-service.ts`
- Create: `apps/api/src/harness-browser-service.test.ts`
- Modify: `apps/api/src/__tests__/snips/v2/lib.ts`
- Create: `apps/api/src/__tests__/snips/v2/browser-local.test.ts`
- Modify: `apps/api/src/__tests__/snips/v2/scrape-browser.test.ts`

- [ ] **Step 1: Add public test helpers**

```ts
export const browserCreateRaw = (body: BrowserCreateInput, identity: Identity) =>
  request(TEST_API_URL).post("/v2/browser").set("Authorization", `Bearer ${identity.apiKey}`).send(body);
export const browserListRaw = (identity: Identity) =>
  request(TEST_API_URL).get("/v2/browser").set("Authorization", `Bearer ${identity.apiKey}`);
export const browserExecuteRaw = (id: string, body: BrowserExecuteInput, identity: Identity) =>
  request(TEST_API_URL).post(`/v2/browser/${encodeURIComponent(id)}/execute`).set("Authorization", `Bearer ${identity.apiKey}`).send(body);
export const browserDeleteRaw = (id: string, identity: Identity) =>
  request(TEST_API_URL).delete(`/v2/browser/${encodeURIComponent(id)}`).set("Authorization", `Bearer ${identity.apiKey}`);
```

Expand `scrapeInteractRaw` body to XOR `prompt?: string`/`code?: string`,
`existingSessionId?`, `allowedDomains?`, `origin?`, and `integration?`.

- [ ] **Step 2: Write direct compatibility happy/failure paths**

Gate on `TEST_SUITE_SELF_HOSTED && LOCAL_BROWSER_SERVICE_ENABLED`. Cover:

```ts
it("creates, lists, fails closed on execute, and deletes a browser", async () => {
  const created = await browserCreateRaw({ ttl: 60, activityTtl: 30, streamWebView: true }, identity);
  expect(created.statusCode).toBe(200);
  expect(created.body.cdpUrl).toContain("/v2/browser/proxy/");
  const executed = await browserExecuteRaw(created.body.id, {
    language: "node",
    timeout: 30,
    allowedDomains: [new URL(TEST_SUITE_WEBSITE).hostname],
    code: `await page.goto(${JSON.stringify(TEST_SUITE_WEBSITE)}); console.log(await page.title());`,
  }, identity);
  expect(executed.statusCode).toBe(503);
  expect(executed.body.error).toMatch(/sandbox.*unavailable/i);
  expect((await browserListRaw(identity)).body.sessions).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: created.body.id })]),
  );
  expect((await browserDeleteRaw(created.body.id, identity)).body.success).toBe(true);
});
```

Add failure paths: cross-owner, second profile writer 409, no allowed domain
403, ninth origin 400/403, passive input denied, expired grant, and duplicate
delete.

- [ ] **Step 3: Add Interact replay, stop, and restart snips**

Replace unsafe legacy test that expects `executeJavascript` replay. API-level
unit tests use injected fake adapters to prove checkpoint handoff and response
mapping. Real harness snips assert code returns `sandbox_unavailable`, prompt
returns `codex_unavailable`, and stop twice succeeds after session creation.
Profile close/reopen proves committed generation without executing code. Host
plan adds real Node/Python/Bash and Codex smoke after adapter/broker exists.

- [ ] **Step 4: Add harness-managed Browser Service lifecycle**

Write `harness-browser-service.test.ts` first. With a fake container runtime
and port allocator, prove the exact managed command:

- builds `firecrawl-local-browser-service:harness` from
  `apps/browser-service` before starting it;
- starts one unique container bound only to an allocated
  `127.0.0.1:<port>:3010`, with generated 32-byte service key and a unique
  temporary browser-state bind mount;
- waits for authenticated `health/ready` before API/worker startup;
- sets `LOCAL_BROWSER_SERVICE_ENABLED=true`, `BROWSER_SERVICE_URL`,
  `BROWSER_SERVICE_API_KEY`, and `LOCAL_BROWSER_STATE_ROOT` in both
  `process.env` and parsed `config` before API spawn; and
- removes its exact container and temporary root on success, command failure,
  signal, or startup failure, without touching normal Compose containers or
  volumes.

Run before implementation:

```bash
pnpm --dir apps/api exec vitest run src/harness-browser-service.test.ts
```

Expected: FAIL because helper does not exist.

Implement `startHarnessBrowserService()` and
`stopHarnessBrowserService()` in `harness-browser-service.ts`. Reuse harness
runtime detection and process forwarding; accept those functions as injected
dependencies instead of duplicating shell execution. Use argument arrays, not
an interpolated shell command. Container receives
`BROWSER_PROFILE_ROOT=/var/lib/firecrawl-browser/profiles` and
`LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser`; API receives the host
temporary root, while contracts pass only relative UUID identifiers. The
harness-only loopback publish is permitted solely for disposable snips;
normal Compose still publishes no Browser Service port.

If `TEST_BROWSER_SERVICE_URL` is set, require
`TEST_BROWSER_SERVICE_API_KEY`, configure the API to use that service, verify
readiness, and do not build, start, stop, or delete external resources. If no
external URL exists and neither Docker nor Podman is installed, fail with the
existing missing-container-runtime message; never install or fall back to an
unmanaged process.

Add `browserService` to `Services`. For the exact
`pnpm test:snips:local-browser` allowlisted command, start Browser Service
after disposable application PostgreSQL/migrations and before API/workers.
Register it immediately for global cleanup, even if readiness or later startup
fails. Stop it after child processes and before application PostgreSQL removal.
Do not enable Browser Service for any other harness command.

Run after implementation:

```bash
pnpm --dir apps/api exec vitest run src/harness-browser-service.test.ts
```

Expected: PASS for managed, external, startup-failure, command-failure, and
signal cleanup paths.

- [ ] **Step 5: Run snips and confirm green state**

Add this package script:

```json
"test:snips:local-browser": "vitest run src/__tests__/snips/v2/browser-local.test.ts src/__tests__/snips/v2/scrape-browser.test.ts"
```

Extend `isLocalPersistenceCommand()` so its exact managed script allowlist is:

```ts
return command[0] === "pnpm" && [
  "test:snips:local-persistence",
  "test:snips:local-browser",
].includes(command[1]);
```

This reuses existing disposable PostgreSQL and controlled fixture path, adds
the disposable Browser Service lifecycle above, and skips the host Go build,
which is unavailable on this machine. Do not broaden the bypass to arbitrary
commands.

From `apps/api`:

```bash
pnpm harness pnpm test:snips:local-browser
```

Expected: direct create/list/delete, profile lock/snapshot, proxy permissions,
cross-owner, unavailable execute/Interact 503, stop, and profile reopen cases
PASS. No real code or prompt execution is claimed by this plan.

- [ ] **Step 6: Run focused unit/service regression**

Run: `pnpm --dir apps/browser-service test`

Expected: all Browser Service tests PASS.

Run:
`pnpm --dir apps/api exec vitest run src/lib/browser-runtime src/lib/browser-state src/lib/scrape-interact src/controllers/v2/browser.test.ts src/controllers/v2/browser-proxy.test.ts`

Expected: all focused API tests PASS.

Run: `pnpm --dir apps/api build`

Expected: PASS.

- [ ] **Step 7: Commit acceptance tests**

Run: `git add apps/api/package.json apps/api/src/harness.ts apps/api/src/harness-browser-service.ts apps/api/src/harness-browser-service.test.ts apps/api/src/__tests__/snips/v2/lib.ts apps/api/src/__tests__/snips/v2/browser-local.test.ts apps/api/src/__tests__/snips/v2/scrape-browser.test.ts`

Run: `apps/api/.husky/_/pre-commit`

Run:

```bash
git commit -m "test: cover local browser API runtime" -m "Exercise direct Browser and scrape Interact contracts against the
private service, including profiles, origins, grants, stop, and restart.

Keep the real Codex smoke gated for host execution acceptance."
```

## Final verification for this plan

- [ ] Run `pnpm --dir apps/browser-service test`; expect all PASS.
- [ ] Run `pnpm --dir apps/browser-service build`; expect PASS.
- [ ] Run `pnpm --dir apps/api build`; expect PASS.
- [ ] Run focused API Vitest command from Task 12; expect all PASS.
- [ ] Run focused snips command from Task 12; expect all enabled cases PASS.
- [ ] Run `docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet`; expect exit 0.
- [ ] Run `docker compose --project-name firecrawl --project-directory . -f compose.yaml build browser-service api`; expect exit 0.
- [ ] Start with flag false; expect Browser/Interact typed unavailable response
  and no hosted fallback in local mode.
- [ ] Start with flag true and healthy dependencies; expect Browser lifecycle
  snips PASS and prompt/code requests to return typed adapter-unavailable 503.
- [ ] Inspect `docker compose --project-name firecrawl --project-directory . -f compose.yaml ps --format json`; expect only API
  published on `127.0.0.1:3002`.
- [ ] Search `rg -n "gemini|fireworks|api.firecrawl.dev" apps/api/src/controllers/v2/browser.ts apps/api/src/controllers/v2/scrape-browser.ts apps/api/src/lib/browser-runtime apps/browser-service/src`; expect no local fallback path.
- [ ] Run `git status --short`; expect clean after each commit.

## Self-review checklist

- Spec coverage: dedicated service, persistent sessions, profile generations,
  one writer/read snapshots, typed operations, constrained evaluate, DNS-pinned
  public egress, 8-origin policy, TTLs, direct API, replayed Interact, stop,
  proxy grants, passive/interactive/CDP separation, restart behavior, and no
  cloud fallback all map to tasks above.
- Dependencies: durable schema/replay is prerequisite. This plan lands the
  narrow adapter interface and fail-closed default; the host plan implements
  the socket client and supplies actual prompt/code processes.
- Type consistency: public session ID differs from private runtime session ID;
  API proxy grants differ from Browser Service relay grants; profile ID and
  generation ID are opaque UUIDs throughout.
- Security boundary: Playwright routing never substitutes for validating egress
  proxy; service-worker traffic is disabled; CDP remains loopback/private.
- Rollout: feature remains false until host execution and full operations plans
  pass their own acceptance gates.
