import { createHash, randomUUID as systemRandomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, devices, type Page } from "playwright";

import {
  actionExecutionRequestSchema,
  type BrowserActionExecutionResultV1,
  closedSessionV1Schema,
  createSessionV1Schema,
  fetchArtifactV1Schema,
  type CreateSessionV1,
  type ClosedSessionV1,
  type FetchArtifactV1,
  type SessionV1,
} from "./contracts.js";
import { SessionActionCache } from "./action-cache.js";
import {
  createChromiumRecordingProducer,
  type RecordingProducer,
} from "./recording-producer.js";
import {
  createEgressProxy as createDefaultEgressProxy,
  createRestoreGate,
  type EgressProxy,
  type EgressProxyOptions,
} from "./egress-proxy.js";
import {
  ProfileStoreError,
  type PreparedProfileGeneration,
  type ProfileStore,
  type WorkingProfile,
} from "./profile-store.js";
import {
  launchPersistentChromiumForWorking as launchPersistentChromiumForWorkingDefault,
  releaseChromiumSessionAttachment as releaseChromiumSessionAttachmentDefault,
  type BoundProfileGeneration,
  type ChromiumSessionAttachment,
  type ReadyProfileRootBinding,
  type ValidatedPersistentChromiumOptions,
  UnverifiedChromiumLaunchError,
} from "./reconciliation.js";
import {
  ReplayRestoreError,
  loadReplayCheckpointFromBytes,
  replayCheckpointStatePath,
  verifySemanticallyEquivalentStorageState,
} from "./replay-restore.js";
import type {
  ControlGenerationBinding,
  StartupAdmission,
} from "./startup-state.js";
import {
  createBrowserOperationSession,
  executeCachedAction,
  type BrowserOperationSession,
  type OperationPage,
} from "./operations.js";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

type CdpChannelLike = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  off(event: string, listener: (params: unknown) => void): void;
  detach(): Promise<void>;
};

declare const sessionRuntimeLeaseBrand: unique symbol;
declare const sessionCdpChannelBrand: unique symbol;

export type SessionRuntimeLease = Readonly<{
  [sessionRuntimeLeaseBrand]: true;
}>;

export type SessionCdpChannel = Readonly<{
  [sessionCdpChannelBrand]: true;
}>;

type RuntimeLeaseRecord = {
  entry: RegistryEntry;
  state: "active" | "revoking" | "revoked";
  controller: AbortController;
  channels: Set<SessionCdpChannel>;
  revocation?: Promise<void>;
};

type CdpChannelRecord = {
  lease: RuntimeLeaseRecord;
  channel: CdpChannelLike;
  state: "active" | "closing" | "closed" | "close_unverified";
  listeners: Map<
    (params: unknown) => void,
    Readonly<{ event: string; subscribed: (params: unknown) => void }>
  >;
};

const runtimeLeaseRecords = new WeakMap<object, RuntimeLeaseRecord>();
const cdpChannelRecords = new WeakMap<object, CdpChannelRecord>();

type SessionErrorCategory =
  | "invalid_request"
  | "replay_unavailable"
  | "replay_unsupported"
  | "browser_unavailable"
  | "concurrency_exceeded"
  | "session_not_found";
const MAX_CLOSED_SESSION_HISTORY = 1_024;

export class SessionRegistryError extends Error {
  readonly category: SessionErrorCategory;
  readonly cleanupCodes: readonly string[];

  constructor(
    category: SessionErrorCategory,
    message: string,
    options: ErrorOptions & { cleanupCodes?: readonly string[] } = {},
  ) {
    super(message, options);
    this.name = "SessionRegistryError";
    this.category = category;
    this.cleanupCodes = Object.freeze([...(options.cleanupCodes ?? [])]);
  }
}

export class TrustedPreSpawnLaunchError extends Error {
  readonly trustedLaunchFailureProof = "preSpawn" as const;
}

type PageLike = OperationPage;

type ContextLike = {
  pages(): PageLike[];
  newPage?(): Promise<PageLike>;
  serviceWorkers?(): Array<{ url(): string }>;
  close(): Promise<void>;
  browser(): { close(): Promise<void>; isConnected(): boolean } | null;
  setStorageState(state: unknown): Promise<void>;
  storageState(options: { indexedDB: true }): Promise<unknown>;
  addCookies?(cookies: CreateSessionV1["settings"]["cookies"]): Promise<void>;
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
  newCDPSession?(page: PageLike): Promise<CdpChannelLike>;
  tracing?: {
    start(options: {
      screenshots: boolean;
      snapshots: boolean;
      sources: boolean;
    }): Promise<void>;
    startChunk(options?: { title?: string }): Promise<void>;
    stopChunk(options?: { path?: string }): Promise<void>;
    stop(): Promise<void>;
  };
};

type Admission = Pick<
  StartupAdmission,
  "processNonce" | "requireReady" | "beginDraining"
>;

type AttachedChromium = Readonly<{ context: ContextLike }>;

type LaunchPersistentChromium = (
  working: BoundProfileGeneration,
  binding: ReadyProfileRootBinding,
  options: PersistentContextOptions,
) => Promise<AttachedChromium>;

type ReleasePersistentChromium = (
  attachment: AttachedChromium,
) => Promise<void>;

type PersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
> & { headless: true; acceptDownloads: false };

type NormalCloseDisposition = {
  reason: "requested" | "expired" | "error" | "shutdown" | "handoff";
  preparedProfile: PreparedProfileGeneration | null;
};

type RegistryEntry = {
  runtimeSessionId: string;
  request: CreateSessionV1;
  state: "provisional" | "ready" | "executing" | "stopping" | "cleanup_failed";
  admission: "open" | "closed";
  sessionVersion: number;
  createdAtMs: number;
  expiresAtMs: number;
  idleExpiresAtMs: number;
  initialOrigin: string | null;
  allowedDomains: string[];
  learnedOrigins: Set<string>;
  deadlineAtMs: number;
  devToolsEndpoint: string | null;
  streamHub: object;
  runtimeLeases: Set<RuntimeLeaseRecord>;
  runtimeLeaseFlights: Set<Promise<void>>;
  activeEffects: Set<Promise<unknown>>;
  recordingProducer: RecordingProducer | undefined;
  traceStarted: boolean;
  actionCache: SessionActionCache;
  operationSession: BrowserOperationSession | undefined;
  work: WorkingProfile | undefined;
  proxy: EgressProxy | undefined;
  context: ContextLike | undefined;
  chromiumAttachment: AttachedChromium | undefined;
  page: PageLike | undefined;
  pageState:
    | { url: string; title: string; snapshotExcerpt: string }
    | undefined;
  writerHeld: boolean;
  writerAbort: AbortController | undefined;
  writerSettlement: Promise<void> | undefined;
  launchAttempt:
    | {
        state: "owned" | "cleanup_unverified";
        publicProcessHandle: null;
      }
    | undefined;
  launchSettlement:
    | { state: "pending" }
    | { state: "fulfilled"; attachment: AttachedChromium }
    | { state: "rejected"; error: unknown }
    | undefined;
  launchRecoveryPromise: Promise<void> | undefined;
  cleanupDetail: string | undefined;
  cleanupCodes: string[];
  contextClosePromise: Promise<void> | undefined;
  contextReleaseRejected: boolean;
  browserClosePromise: Promise<void> | undefined;
  browserCloseState: "idle" | "closing" | "rejected" | "settled";
  contextCloseVerified: boolean;
  runtimeDrainStarted: boolean;
  beginRuntimeDrain(): void;
  observeCleanupEffect(effect: Promise<unknown>): Promise<boolean>;
  normalClose: NormalCloseDisposition | undefined;
  closeResult?: ClosedSession;
};

export type ClosedSession = ClosedSessionV1;

export type SessionRegistry = {
  create(input: unknown): Promise<SessionV1>;
  get(runtimeSessionId: string): SessionV1 | undefined;
  touch(runtimeSessionId: string): SessionV1;
  withWriter<T>(
    runtimeSessionId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  withRuntime<T>(
    runtimeSessionId: string,
    mode: "passive" | "writer",
    operation: (lease: SessionRuntimeLease) => Promise<T>,
  ): Promise<T>;
  executeAction(
    runtimeSessionId: string,
    input: unknown,
  ): Promise<BrowserActionExecutionResultV1>;
  extendAuthority(
    runtimeSessionId: string,
    expectedSessionVersion: number,
    allowedDomains: readonly string[],
  ): Promise<SessionV1>;
  close(
    runtimeSessionId: string,
    reason: "requested" | "expired" | "error" | "shutdown" | "handoff",
  ): Promise<ClosedSession>;
  sweepExpired(): Promise<void>;
  sweepCleanupFailed(): Promise<void>;
  drainAll(
    reason: "handoff" | "shutdown",
    admission?: {
      signal: AbortSignal;
      assertWaveActive(): void;
    },
  ): Promise<void>;
  entries(): Array<Record<string, unknown>>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asError(
  category: SessionErrorCategory,
  message: string,
  cause?: unknown,
) {
  return new SessionRegistryError(
    category,
    message,
    cause === undefined ? {} : { cause },
  );
}

function requireRuntimeLease(lease: SessionRuntimeLease): RuntimeLeaseRecord {
  const record = runtimeLeaseRecords.get(lease as object);
  if (
    record === undefined ||
    record.state !== "active" ||
    record.entry.admission !== "open" ||
    (record.entry.state !== "ready" && record.entry.state !== "executing")
  ) {
    throw asError("session_not_found", "session runtime lease is invalid");
  }
  return record;
}

function requireCdpChannel(channel: SessionCdpChannel): CdpChannelRecord {
  const record = cdpChannelRecords.get(channel as object);
  if (
    record === undefined ||
    record.state !== "active" ||
    record.lease.state !== "active" ||
    record.lease.entry.admission !== "open" ||
    (record.lease.entry.state !== "ready" &&
      record.lease.entry.state !== "executing")
  ) {
    throw asError("session_not_found", "session CDP channel is invalid");
  }
  return record;
}

function trackBrowserEffect<T>(
  entry: RegistryEntry,
  effect: Promise<T>,
): Promise<T> {
  entry.activeEffects.add(effect);
  void effect.then(
    () => entry.activeEffects.delete(effect),
    () => entry.activeEffects.delete(effect),
  );
  return effect;
}

export function sessionRuntimeSignal(lease: SessionRuntimeLease): AbortSignal {
  return requireRuntimeLease(lease).controller.signal;
}

export async function openSessionCdpChannel(
  lease: SessionRuntimeLease,
): Promise<SessionCdpChannel> {
  const leaseRecord = requireRuntimeLease(lease);
  const { entry } = leaseRecord;
  if (entry.context?.newCDPSession === undefined || entry.page === undefined) {
    throw asError("browser_unavailable", "session CDP is unavailable");
  }
  const channel = await trackBrowserEffect(
    entry,
    entry.context.newCDPSession(entry.page),
  );
  try {
    requireRuntimeLease(lease);
  } catch (cause) {
    const detached = trackBrowserEffect(entry, channel.detach());
    if (!(await entry.observeCleanupEffect(detached))) {
      entry.beginRuntimeDrain();
      throw asError(
        "browser_unavailable",
        "late session CDP channel cleanup is unverified",
        cause,
      );
    }
    throw cause;
  }
  const token = Object.freeze({}) as SessionCdpChannel;
  cdpChannelRecords.set(token, {
    lease: leaseRecord,
    channel,
    state: "active",
    listeners: new Map(),
  });
  leaseRecord.channels.add(token);
  return token;
}

export async function sendSessionCdpCommand(
  token: SessionCdpChannel,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (
    typeof method !== "string" ||
    method.length === 0 ||
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    throw asError("invalid_request", "CDP command is invalid");
  }
  const record = requireCdpChannel(token);
  const result = await trackBrowserEffect(
    record.lease.entry,
    record.channel.send(method, params),
  );
  requireCdpChannel(token);
  return result;
}

export function subscribeSessionCdpEvent(
  token: SessionCdpChannel,
  event: string,
  listener: (params: unknown) => void,
): () => void {
  const record = requireCdpChannel(token);
  if (
    typeof event !== "string" ||
    event.length === 0 ||
    typeof listener !== "function"
  ) {
    throw asError("invalid_request", "CDP listener is invalid");
  }
  const subscribed = (params: unknown): void => {
    if (record.state === "active" && record.lease.state === "active") {
      listener(params);
    }
  };
  record.channel.on(event, subscribed);
  record.listeners.set(listener, Object.freeze({ event, subscribed }));
  let active = true;
  return Object.freeze(() => {
    if (!active) return;
    active = false;
    record.channel.off(event, subscribed);
    record.listeners.delete(listener);
  });
}

export async function closeSessionCdpChannel(
  token: SessionCdpChannel,
): Promise<void> {
  const record = cdpChannelRecords.get(token as object);
  if (record === undefined || record.state === "closed") return;
  if (record.state === "closing" || record.state === "close_unverified") {
    throw asError("browser_unavailable", "CDP channel cleanup is unverified");
  }
  record.state = "closing";
  try {
    for (const [listener, subscription] of record.listeners) {
      record.channel.off(subscription.event, subscription.subscribed);
      record.listeners.delete(listener);
    }
    const detached = trackBrowserEffect(
      record.lease.entry,
      record.channel.detach(),
    );
    if (!(await record.lease.entry.observeCleanupEffect(detached))) {
      throw new Error("CDP detach did not settle");
    }
    record.state = "closed";
    record.lease.channels.delete(token);
    cdpChannelRecords.delete(token as object);
  } catch (cause) {
    record.state = "close_unverified";
    record.lease.entry.beginRuntimeDrain();
    throw new SessionRegistryError(
      "browser_unavailable",
      "CDP channel cleanup is unverified",
      { cause },
    );
  }
}

async function captureTrace(entry: RegistryEntry): Promise<Uint8Array> {
  if (!entry.traceStarted || entry.context?.tracing === undefined) {
    throw asError("browser_unavailable", "session trace is unavailable");
  }
  const directory = await mkdtemp(join(tmpdir(), "firecrawl-browser-trace-"));
  const path = join(directory, "diagnostic.zip");
  let stopped = false;
  let restarted = false;
  try {
    await entry.context.tracing.stopChunk({ path });
    stopped = true;
    const trace = await open(path, "r");
    let bytes: Uint8Array;
    try {
      const traceStat = await trace.stat();
      if (
        !traceStat.isFile() ||
        traceStat.size === 0 ||
        traceStat.size > MAX_CAPTURE_BYTES
      ) {
        throw asError("browser_unavailable", "session trace exceeds its limit");
      }
      bytes = Uint8Array.from(await trace.readFile());
      if (bytes.byteLength !== traceStat.size) {
        throw asError("browser_unavailable", "session trace size changed");
      }
    } finally {
      await trace.close();
    }
    await entry.context.tracing.startChunk({ title: "diagnostic-v1" });
    restarted = true;
    stopped = false;
    return bytes;
  } catch (cause) {
    if (stopped && !restarted) {
      entry.traceStarted = false;
      entry.beginRuntimeDrain();
    }
    throw cause;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function captureSessionArtifact(
  lease: SessionRuntimeLease,
  input: FetchArtifactV1,
): Promise<Readonly<{ contentType: string; bytes: Uint8Array }>> {
  const leaseRecord = requireRuntimeLease(lease);
  const request = fetchArtifactV1Schema.parse(input);
  const entry = leaseRecord.entry;
  const capture = async (): Promise<
    Readonly<{ contentType: string; bytes: Uint8Array }>
  > => {
    let contentType: string;
    let bytes: Uint8Array;
    if (request.kind === "screenshot") {
      if (entry.page === undefined) {
        throw asError("browser_unavailable", "session page is unavailable");
      }
      contentType = request.format === "png" ? "image/png" : "image/jpeg";
      bytes = await entry.page.screenshot({
        type: request.format,
        fullPage: request.fullPage,
      });
    } else if (request.kind === "recording") {
      if (entry.recordingProducer === undefined) {
        throw asError(
          "browser_unavailable",
          "session recording is unavailable",
        );
      }
      contentType = "video/webm";
      bytes = await entry.recordingProducer.snapshot();
    } else {
      contentType = "application/zip";
      bytes = await captureTrace(entry);
    }
    requireRuntimeLease(lease);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_BYTES) {
      throw asError("browser_unavailable", "artifact exceeds its byte limit");
    }
    return Object.freeze({ contentType, bytes });
  };
  return trackBrowserEffect(entry, capture());
}

async function revokeRuntimeLease(record: RuntimeLeaseRecord): Promise<void> {
  if (record.revocation !== undefined) return record.revocation;
  record.revocation = (async () => {
    if (record.state === "revoked") return;
    record.state = "revoking";
    record.controller.abort();
    const results = await Promise.allSettled(
      [...record.channels].map((channel) => closeSessionCdpChannel(channel)),
    );
    record.channels.clear();
    record.state = "revoked";
    record.entry.runtimeLeases.delete(record);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length !== 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "runtime lease cleanup is unverified",
      );
    }
  })();
  return record.revocation;
}

function launchOptions(
  request: CreateSessionV1,
  proxyUrl: string,
  launchTimeoutMs: number,
): PersistentContextOptions {
  const settings = request.settings;
  const device =
    settings.deviceName === undefined
      ? {}
      : { ...devices[settings.deviceName] };
  if ("defaultBrowserType" in device) delete device.defaultBrowserType;
  const options = {
    ...device,
    headless: true,
    acceptDownloads: false as const,
    timeout: launchTimeoutMs,
    serviceWorkers: "block",
    proxy: { server: proxyUrl, bypass: "<-loopback>" },
    args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
    extraHTTPHeaders: settings.headers,
    viewport: {
      width: settings.viewport.width,
      height: settings.viewport.height,
    },
    deviceScaleFactor: settings.viewport.deviceScaleFactor,
    isMobile: settings.viewport.isMobile,
    hasTouch: settings.viewport.hasTouch,
    userAgent: settings.userAgent,
    locale: settings.locale,
    ignoreHTTPSErrors: settings.skipTlsVerification,
  } as PersistentContextOptions;
  if (settings.timezoneId !== undefined)
    options.timezoneId = settings.timezoneId;
  if (settings.geolocation !== undefined)
    options.geolocation = settings.geolocation;
  return options;
}

function validateSupportedSettings(request: CreateSessionV1): void {
  if (
    request.settings.deviceName !== undefined &&
    devices[request.settings.deviceName] === undefined
  ) {
    throw asError("replay_unsupported", "unknown Playwright device");
  }
  if (request.settings.proxy.credentialRef !== undefined) {
    throw asError(
      "replay_unsupported",
      "proxy credential reference is unavailable",
    );
  }
  if (
    request.settings.proxy.kind !== "auto" ||
    request.settings.proxy.country !== undefined
  ) {
    throw asError(
      "replay_unsupported",
      "upstream proxy setting is unavailable",
    );
  }
  if (request.settings.blockAds || !request.settings.lockdown) {
    throw asError(
      "replay_unsupported",
      "requested browser policy is unavailable",
    );
  }
}

function validateSessionTargets(request: CreateSessionV1): void {
  const allowed = request.allowedDomains.map((domain) => domain.toLowerCase());
  for (const target of [
    ...(request.initialUrl === "about:blank" ? [] : [request.initialUrl]),
    ...(request.replay === null ? [] : [request.replay.finalUrl]),
  ]) {
    const hostname = new URL(target).hostname.toLowerCase();
    if (
      !allowed.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
    ) {
      throw asError(
        "invalid_request",
        "session target is outside allowed domains",
      );
    }
  }
}

function validateProfileAuthority(request: CreateSessionV1): void {
  const profile = request.profile;
  if (profile?.generationId === null || profile === null) return;
  if (profile?.generationId === undefined) return;
  const expected = `profiles/${profile.profileId}/committed/${profile.generationId}`;
  if (profile.statePath !== expected) {
    throw asError("invalid_request", "profile statePath is not canonical");
  }
}

function rejectUnsupportedRawRequest(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  const candidate = input as {
    replay?: unknown;
    profile?: { generationId?: unknown } | null;
    settings?: { timezoneId?: unknown; deviceName?: unknown };
  };
  if (
    candidate.replay !== null &&
    candidate.replay !== undefined &&
    candidate.profile?.generationId !== null &&
    candidate.profile?.generationId !== undefined
  ) {
    throw asError(
      "replay_unsupported",
      "replay and an existing profile generation are mutually exclusive",
    );
  }
  const timezone = candidate.settings?.timezoneId;
  if (typeof timezone === "string") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw asError("replay_unsupported", "unknown IANA time zone");
    }
  }
  const deviceName = candidate.settings?.deviceName;
  if (typeof deviceName === "string" && devices[deviceName] === undefined) {
    throw asError("replay_unsupported", "unknown Playwright device");
  }
}

function publicSession(entry: RegistryEntry): SessionV1 {
  if (
    entry.state !== "ready" &&
    entry.state !== "executing" &&
    entry.state !== "stopping"
  ) {
    throw asError("session_not_found", "session is not public");
  }
  const page = entry.page!;
  return {
    version: 1,
    runtimeSessionId: entry.runtimeSessionId,
    state: entry.state,
    sessionVersion: entry.sessionVersion,
    page: {
      url: entry.pageState?.url ?? page.url(),
      title: entry.pageState?.title ?? "",
      snapshotExcerpt: entry.pageState?.snapshotExcerpt ?? "",
    },
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    idleExpiresAt: new Date(entry.idleExpiresAtMs).toISOString(),
  };
}

async function acquireLaunchOwnedPage(context: ContextLike): Promise<PageLike> {
  const existing = context.pages();
  const workers = context.serviceWorkers?.() ?? [];
  if (
    existing.length > 1 ||
    workers.length !== 0 ||
    existing.some((page) => page.url() !== "about:blank")
  ) {
    throw asError(
      "browser_unavailable",
      "persistent context has unexpected launch-owned pages",
    );
  }
  if (existing[0] !== undefined) return existing[0];
  if (context.newPage === undefined) {
    throw asError("browser_unavailable", "persistent context has no page");
  }
  const page = await context.newPage();
  if (page.url() !== "about:blank") {
    throw asError(
      "browser_unavailable",
      "persistent context created a non-inert page",
    );
  }
  return page;
}

export function createSessionRegistry(options: {
  admission: Admission;
  binding: ControlGenerationBinding;
  profileStore: Pick<
    ProfileStore,
    | "workingGeneration"
    | "readRootFile"
    | "createWorkingCopy"
    | "discardWorkingCopy"
    | "prepareWorkingCopy"
    | "finalizePreparedGeneration"
  >;
  createEgressProxy?: (options: EgressProxyOptions) => Promise<EgressProxy>;
  launchPersistentChromiumForWorking?: LaunchPersistentChromium;
  releaseChromiumSessionAttachment?: ReleasePersistentChromium;
  afterChromiumAttachment?: () => void;
  now?: () => number;
  randomUUID?: () => string;
  cleanupTimeoutMs?: number;
  launchTimeoutMs?: number;
  operationTimeoutMs?: number;
  afterRuntimeLeaseSnapshot?: () => Promise<void>;
  createRecordingProducer?: (
    page: Page,
    options: {
      width: number;
      height: number;
      frameRate: number;
      maximumBytes: number;
      quality: number;
    },
  ) => Promise<RecordingProducer>;
}): SessionRegistry {
  const createProxy = options.createEgressProxy ?? createDefaultEgressProxy;
  const launch =
    options.launchPersistentChromiumForWorking ??
    (launchPersistentChromiumForWorkingDefault as unknown as LaunchPersistentChromium);
  const release =
    options.releaseChromiumSessionAttachment ??
    (releaseChromiumSessionAttachmentDefault as unknown as ReleasePersistentChromium);
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? systemRandomUUID;
  const entriesByRuntime = new Map<string, RegistryEntry>();
  const runtimeByRequest = new Map<string, string>();
  const closed = new Map<string, ClosedSession>();
  const closeFlights = new Map<string, Promise<ClosedSession>>();
  const pendingSessionIds = new Set<string>();
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  const launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
  const createRecordingProducer =
    options.createRecordingProducer ?? createChromiumRecordingProducer;
  let registryAdmissionOpen = true;

  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new RangeError("cleanupTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(launchTimeoutMs) || launchTimeoutMs <= 0) {
    throw new RangeError("launchTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new RangeError("operationTimeoutMs must be a positive safe integer");
  }

  async function runWithinDeadline<T>(
    entry: RegistryEntry,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    assertOperationAdmitted(entry);
    const timeoutMs = Math.min(operationTimeoutMs, entry.deadlineAtMs - now());
    if (timeoutMs <= 0) throw new Error("session deadline exceeded");
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      throw error;
    }
    entry.activeEffects.add(running);
    void running.then(
      () => entry.activeEffects.delete(running),
      () => entry.activeEffects.delete(running),
    );
    try {
      let removeAbort = (): void => undefined;
      const aborted =
        signal === undefined
          ? undefined
          : new Promise<never>((_resolve, reject) => {
              const abort = () =>
                reject(
                  signal.reason ??
                    asError(
                      "browser_unavailable",
                      "session writer authority ended",
                    ),
                );
              removeAbort = () => signal.removeEventListener("abort", abort);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
      const result = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("session operation timed out")),
            timeoutMs,
          );
        }),
        ...(aborted === undefined ? [] : [aborted]),
      ]).finally(removeAbort);
      assertOperationAdmitted(entry);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function applyAuthority(
    entry: RegistryEntry,
    expectedSessionVersion: number,
    allowedDomains: readonly string[],
  ): Promise<void> {
    if (entry.sessionVersion !== expectedSessionVersion) {
      throw asError("concurrency_exceeded", "session version does not match");
    }
    const next = [...new Set(allowedDomains)].sort();
    if (
      next.length !== allowedDomains.length ||
      next.length > 8 ||
      entry.allowedDomains.some((domain) => !next.includes(domain))
    ) {
      throw asError("invalid_request", "session authority is not monotonic");
    }
    if (
      next.length === entry.allowedDomains.length &&
      next.every((domain, index) => domain === entry.allowedDomains[index])
    ) {
      return;
    }
    if (entry.operationSession !== undefined) {
      await entry.operationSession.dispose();
      entry.operationSession = undefined;
    }
    entry.allowedDomains.splice(0, entry.allowedDomains.length, ...next);
  }

  function runAdmitted<T>(entry: RegistryEntry, operation: () => T): T {
    assertOperationAdmitted(entry);
    const result = operation();
    assertOperationAdmitted(entry);
    return result;
  }

  async function observeWithin(
    promise: Promise<void>,
    timeoutMs = cleanupTimeoutMs,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => false,
        ),
        new Promise<false>(resolve => {
          timer = setTimeout(resolve, timeoutMs, false);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function requireReady(): ReadyProfileRootBinding {
    if (!registryAdmissionOpen) {
      throw asError("browser_unavailable", "session registry is draining");
    }
    return options.admission.requireReady(options.binding);
  }

  function requireEntry(runtimeSessionId: string): RegistryEntry {
    const entry = entriesByRuntime.get(runtimeSessionId);
    if (entry === undefined)
      throw asError("session_not_found", "session not found");
    return entry;
  }

  function assertProvisioningAdmitted(entry: RegistryEntry): void {
    requireReady();
    if (entry.state !== "provisional") {
      throw asError("session_not_found", "session provisioning is closed");
    }
    const deadline = Math.min(entry.expiresAtMs, entry.idleExpiresAtMs);
    if (now() >= deadline) throw new Error("session deadline exceeded");
    entry.deadlineAtMs = deadline;
  }

  function assertEntryAdmitted(entry: RegistryEntry): void {
    requireReady();
    if (
      entry.admission !== "open" ||
      (entry.state !== "ready" && entry.state !== "executing")
    ) {
      throw asError("session_not_found", "session admission is closed");
    }
    const deadline = Math.min(entry.expiresAtMs, entry.idleExpiresAtMs);
    if (now() >= deadline) throw new Error("session deadline exceeded");
    entry.deadlineAtMs = deadline;
  }

  function assertOperationAdmitted(entry: RegistryEntry): void {
    if (entry.state === "provisional") {
      assertProvisioningAdmitted(entry);
    } else {
      assertEntryAdmitted(entry);
    }
  }

  function isExpired(entry: RegistryEntry): boolean {
    const at = now();
    return at >= entry.idleExpiresAtMs || at >= entry.expiresAtMs;
  }

  function rememberClosed(
    runtimeSessionId: string,
    result: ClosedSession,
  ): void {
    if (
      !closed.has(runtimeSessionId) &&
      closed.size >= MAX_CLOSED_SESSION_HISTORY
    ) {
      throw new Error("closed session history capacity is exhausted");
    }
    closed.set(runtimeSessionId, result);
  }

  async function closeContext(entry: RegistryEntry): Promise<boolean> {
    if (entry.chromiumAttachment === undefined) {
      return entry.context === undefined;
    }
    if (entry.contextCloseVerified) return true;
    if (entry.contextClosePromise === undefined) {
      entry.contextReleaseRejected = false;
      try {
        entry.contextClosePromise = release(entry.chromiumAttachment);
      } catch {
        entry.contextClosePromise = Promise.reject(
          new Error("attachment release threw synchronously"),
        );
      }
      void entry.contextClosePromise.catch(() => {
        entry.contextReleaseRejected = true;
      });
    }
    if (await observeWithin(entry.contextClosePromise)) {
      entry.contextCloseVerified = true;
      entry.chromiumAttachment = undefined;
      entry.context = undefined;
      return true;
    }
    if (entry.contextReleaseRejected) entry.contextClosePromise = undefined;
    return false;
  }

  async function cleanupEntry(
    entry: RegistryEntry,
    discardProfile: boolean,
  ): Promise<readonly string[]> {
    const cleanupCodes: string[] = [];
    const leaseSnapshot = [...entry.runtimeLeases];
    const runtimeFlightSnapshot = [...entry.runtimeLeaseFlights];
    await options.afterRuntimeLeaseSnapshot?.();
    const leaseResults = await Promise.allSettled(
      leaseSnapshot.map((lease) => revokeRuntimeLease(lease)),
    );
    if (leaseResults.some((result) => result.status === "rejected")) {
      cleanupCodes.push("runtime_lease_cleanup_failed");
      entry.beginRuntimeDrain();
    }
    if (runtimeFlightSnapshot.length !== 0) {
      const settled = Promise.allSettled(runtimeFlightSnapshot).then(
        () => undefined,
      );
      if (!(await observeWithin(settled))) {
        cleanupCodes.push("runtime_lease_drain_failed");
        entry.beginRuntimeDrain();
      }
    }
    if (entry.recordingProducer !== undefined) {
      try {
        await entry.recordingProducer.close();
        entry.recordingProducer = undefined;
      } catch {
        cleanupCodes.push("recording_cleanup_failed");
        entry.beginRuntimeDrain();
      }
    }
    if (entry.traceStarted && entry.context?.tracing !== undefined) {
      try {
        await entry.context.tracing.stop();
        entry.traceStarted = false;
      } catch {
        cleanupCodes.push("trace_cleanup_failed");
        entry.beginRuntimeDrain();
      }
    }
    if (entry.operationSession !== undefined) {
      try {
        await entry.operationSession.dispose();
        entry.operationSession = undefined;
      } catch {
        cleanupCodes.push("operation_session_dispose_failed");
      }
    }
    let contextClosed = false;
    try {
      contextClosed = await closeContext(entry);
    } catch {
      contextClosed = false;
    }
    if (!contextClosed) cleanupCodes.push("chromium_close_failed");
    if (contextClosed && entry.activeEffects.size !== 0) {
      const settled = Promise.allSettled([...entry.activeEffects]).then(
        () => undefined,
      );
      if (!(await observeWithin(settled))) {
        cleanupCodes.push("browser_effect_drain_failed");
        if (!entry.runtimeDrainStarted) {
          entry.runtimeDrainStarted = true;
          options.admission.beginDraining();
        }
      }
    }
    if (!contextClosed && !entry.runtimeDrainStarted) {
      entry.runtimeDrainStarted = true;
      options.admission.beginDraining();
    }
    entry.proxy?.restoreGate?.close();
    if (entry.proxy !== undefined) {
      let listenerClosed = false;
      try {
        const proxyClose = entry.proxy.close();
        void proxyClose.catch(() => undefined);
        if (!(await observeWithin(proxyClose))) {
          throw new Error("proxy listener close was not verified");
        }
        listenerClosed = true;
      } catch {
        cleanupCodes.push("proxy_listener_close_failed");
      }
      let liveSockets = 1;
      try {
        liveSockets = entry.proxy.liveSocketCount();
      } catch {
        liveSockets = 1;
      }
      if (liveSockets !== 0) {
        cleanupCodes.push("proxy_socket_drain_failed");
      } else if (listenerClosed) {
        entry.proxy = undefined;
      }
    }
    if (discardProfile && contextClosed && entry.work !== undefined) {
      try {
        await options.profileStore.discardWorkingCopy(entry.work);
        entry.work = undefined;
      } catch {
        cleanupCodes.push("profile_discard_failed");
      }
    }
    const unique = [...new Set(cleanupCodes)];
    entry.cleanupCodes = unique;
    return unique;
  }

  async function recoverSettledLaunch(entry: RegistryEntry): Promise<void> {
    if (entry.launchRecoveryPromise !== undefined) {
      await entry.launchRecoveryPromise;
      return;
    }
    if (
      entry.state !== "cleanup_failed" ||
      entry.cleanupDetail !== "launch_cleanup_unverified"
    ) {
      return;
    }
    const settlement = entry.launchSettlement;
    const recoverable =
      settlement?.state === "fulfilled" ||
      (settlement?.state === "rejected" &&
        (settlement.error instanceof TrustedPreSpawnLaunchError ||
          settlement.error instanceof UnverifiedChromiumLaunchError));
    if (!recoverable) return;
    const recovery = (async () => {
      if (settlement.state === "fulfilled") {
        entry.chromiumAttachment = settlement.attachment;
        entry.context = settlement.attachment.context;
      } else if (
        settlement.state === "rejected" &&
        settlement.error instanceof UnverifiedChromiumLaunchError
      ) {
        entry.chromiumAttachment = settlement.error
          .attachment as unknown as AttachedChromium;
        entry.context = entry.chromiumAttachment.context;
      }
      entry.launchAttempt = undefined;
      entry.cleanupDetail = "resource_cleanup_failed";
      const cleanupCodes = await cleanupEntry(entry, true);
      if (cleanupCodes.length === 0) {
        entriesByRuntime.delete(entry.runtimeSessionId);
        runtimeByRequest.delete(entry.request.sessionId);
      }
    })();
    entry.launchRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      entry.launchRecoveryPromise = undefined;
    }
  }

  async function observeLaunch(
    entry: RegistryEntry,
    operation: () => Promise<AttachedChromium>,
    timeoutMs: number,
  ): Promise<AttachedChromium> {
    entry.launchSettlement = { state: "pending" };
    const launched = Promise.resolve().then(operation);
    const observed = launched.then(
      (attachment) => {
        entry.launchSettlement = { state: "fulfilled", attachment };
        entry.chromiumAttachment = attachment;
        void recoverSettledLaunch(entry).catch(() => undefined);
        return attachment;
      },
      (error: unknown) => {
        entry.launchSettlement = { state: "rejected", error };
        void recoverSettledLaunch(entry).catch(() => undefined);
        throw error;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        observed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Chromium launch timed out")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function failAfterContext(
    entry: RegistryEntry,
    category: "replay_unavailable" | "browser_unavailable",
    cause: unknown,
  ): Promise<never> {
    entry.admission = "closed";
    const cleanupCodes = await cleanupEntry(entry, true);
    if (cleanupCodes.length === 0) {
      entriesByRuntime.delete(entry.runtimeSessionId);
      runtimeByRequest.delete(entry.request.sessionId);
    } else {
      entry.state = "cleanup_failed";
      entry.cleanupDetail = "resource_cleanup_failed";
      entry.cleanupCodes = [...cleanupCodes];
    }
    throw new SessionRegistryError(category, "session creation failed", {
      cause,
      cleanupCodes,
    });
  }

  const registry: SessionRegistry = {
    async create(input) {
      requireReady();
      rejectUnsupportedRawRequest(input);
      const parsed = createSessionV1Schema.safeParse(input);
      if (!parsed.success) {
        throw asError(
          "invalid_request",
          "create session request is invalid",
          parsed.error,
        );
      }
      const request = parsed.data;
      validateSupportedSettings(request);
      validateSessionTargets(request);
      validateProfileAuthority(request);
      if (request.replay !== null && request.settings.cookies.length !== 0) {
        throw asError(
          "replay_unsupported",
          "replay cannot apply additional settings cookies",
        );
      }
      if (
        runtimeByRequest.has(request.sessionId) ||
        pendingSessionIds.has(request.sessionId)
      ) {
        throw asError("invalid_request", "sessionId is already owned");
      }
      if (
        closed.size + entriesByRuntime.size + pendingSessionIds.size >=
        MAX_CLOSED_SESSION_HISTORY
      ) {
        throw asError(
          "concurrency_exceeded",
          "session idempotency capacity is exhausted",
        );
      }
      const createdAtMs = now();
      const creationDeadlineAtMs =
        createdAtMs +
        Math.min(request.ttlSeconds, request.activityTtlSeconds) * 1_000;
      pendingSessionIds.add(request.sessionId);
      let replayState: ReturnType<typeof loadReplayCheckpointFromBytes> | null =
        null;
      try {
        if (request.replay !== null) {
          requireReady();
          if (now() >= creationDeadlineAtMs)
            throw asError("replay_unavailable", "session deadline exceeded");
          const statePath = replayCheckpointStatePath(request.replay);
          const rawBytes = await options.profileStore.readRootFile(
            statePath,
            2 * 1024 * 1024 + 1,
          );
          replayState = loadReplayCheckpointFromBytes(request.replay, rawBytes);
          requireReady();
          if (now() >= creationDeadlineAtMs)
            throw asError("replay_unavailable", "session deadline exceeded");
        }
      } catch (error) {
        pendingSessionIds.delete(request.sessionId);
        throw error;
      }
      let runtimeSessionId: string;
      try {
        requireReady();
        if (now() >= creationDeadlineAtMs)
          throw asError("browser_unavailable", "session deadline exceeded");
        runtimeSessionId = randomUUID();
      } catch (error) {
        pendingSessionIds.delete(request.sessionId);
        throw error;
      }
      const entry: RegistryEntry = {
        runtimeSessionId,
        request,
        state: "provisional",
        admission: "closed",
        sessionVersion: 1,
        createdAtMs,
        expiresAtMs: createdAtMs + request.ttlSeconds * 1_000,
        idleExpiresAtMs: createdAtMs + request.activityTtlSeconds * 1_000,
        initialOrigin:
          request.initialUrl === "about:blank"
            ? null
            : new URL(request.initialUrl).origin,
        allowedDomains: [...request.allowedDomains].sort(),
        learnedOrigins: new Set(
          request.initialUrl === "about:blank"
            ? []
            : [new URL(request.initialUrl).origin],
        ),
        deadlineAtMs: creationDeadlineAtMs,
        devToolsEndpoint: null,
        streamHub: Object.freeze({}),
        runtimeLeases: new Set(),
        runtimeLeaseFlights: new Set(),
        activeEffects: new Set(),
        recordingProducer: undefined,
        traceStarted: false,
        actionCache: new SessionActionCache(),
        operationSession: undefined,
        writerHeld: false,
        writerAbort: undefined,
        writerSettlement: undefined,
        contextCloseVerified: false,
        runtimeDrainStarted: false,
        beginRuntimeDrain: () => {
          if (entry.runtimeDrainStarted) return;
          entry.runtimeDrainStarted = true;
          options.admission.beginDraining();
        },
        observeCleanupEffect: (effect) =>
          observeWithin(effect.then(() => undefined)),
        work: undefined,
        proxy: undefined,
        context: undefined,
        chromiumAttachment: undefined,
        page: undefined,
        pageState: undefined,
        launchAttempt: undefined,
        launchSettlement: undefined,
        launchRecoveryPromise: undefined,
        cleanupDetail: undefined,
        cleanupCodes: [],
        contextClosePromise: undefined,
        contextReleaseRejected: false,
        browserClosePromise: undefined,
        browserCloseState: "idle",
        normalClose: undefined,
      };
      entriesByRuntime.set(runtimeSessionId, entry);
      runtimeByRequest.set(request.sessionId, runtimeSessionId);
      pendingSessionIds.delete(request.sessionId);
      const profile = request.profile;
      const profileId = profile?.profileId ?? request.sessionId;
      const mode = profile?.mode ?? "snapshot";
      const base =
        profile?.generationId === undefined || profile.generationId === null
          ? null
          : {
              generationId: profile.generationId,
              statePath: profile.statePath!,
              checksum: profile.checksum!,
            };
      try {
        try {
          assertProvisioningAdmitted(entry);
          entry.work = await options.profileStore.createWorkingCopy(
            profileId,
            base,
            mode,
            request.sessionId,
          );
          assertProvisioningAdmitted(entry);
        } catch (error) {
          if (
            error instanceof ProfileStoreError &&
            error.retainedWork !== undefined
          ) {
            entry.work = error.retainedWork;
          }
          if (error instanceof ProfileStoreError && error.cleanupUnverified) {
            entry.state = "cleanup_failed";
            entry.admission = "closed";
            entry.cleanupDetail = "profile_acquisition_cleanup_unverified";
            entry.cleanupCodes = [];
            options.admission.beginDraining();
            throw new SessionRegistryError(
              request.replay === null
                ? "browser_unavailable"
                : "replay_unavailable",
              "profile acquisition cleanup is unverified",
              { cause: error, cleanupCodes: [] },
            );
          }
          throw error;
        }
        assertProvisioningAdmitted(entry);
        entry.proxy = await createProxy({
          restoreGate: createRestoreGate(),
          allowedDomains: entry.allowedDomains,
          deadlineAtMs: () =>
            Math.min(entry.expiresAtMs, entry.idleExpiresAtMs),
        });
        assertProvisioningAdmitted(entry);
        const gate = entry.proxy.restoreGate;
        if (gate === undefined) {
          throw asError(
            "browser_unavailable",
            "egress proxy omitted restore gate",
          );
        }
        const launchRemainingMs = entry.deadlineAtMs - now();
        if (launchRemainingMs <= 0) {
          throw asError(
            request.replay === null
              ? "browser_unavailable"
              : "replay_unavailable",
            "session deadline expired before Chromium launch",
          );
        }
        assertProvisioningAdmitted(entry);
        entry.launchAttempt = { state: "owned", publicProcessHandle: null };
        let context: ContextLike;
        try {
          const boundedLaunchMs = Math.max(
            1,
            Math.min(launchTimeoutMs, launchRemainingMs),
          );
          const workingGeneration = options.profileStore.workingGeneration(
            entry.work,
          );
          const readyBinding = requireReady();
          const persistentOptions = launchOptions(
            request,
            entry.proxy.url,
            boundedLaunchMs,
          );
          const attachment = await observeLaunch(
            entry,
            () => launch(workingGeneration, readyBinding, persistentOptions),
            boundedLaunchMs,
          );
          entry.chromiumAttachment = attachment;
          context = attachment.context;
          options.afterChromiumAttachment?.();
        } catch (error) {
          if (error instanceof UnverifiedChromiumLaunchError) {
            entry.chromiumAttachment =
              error.attachment as unknown as AttachedChromium;
            if (!entry.runtimeDrainStarted) {
              entry.runtimeDrainStarted = true;
              options.admission.beginDraining();
            }
          }
          if (entry.chromiumAttachment !== undefined) {
            entry.launchAttempt = undefined;
            throw error;
          }
          if (error instanceof TrustedPreSpawnLaunchError) {
            entry.launchAttempt = undefined;
            throw asError(
              request.replay === null
                ? "browser_unavailable"
                : "replay_unavailable",
              "Chromium launch failed before spawn",
              error,
            );
          }
          entry.launchAttempt = {
            state: "cleanup_unverified",
            publicProcessHandle: null,
          };
          entry.state = "cleanup_failed";
          entry.admission = "closed";
          entry.cleanupDetail = "launch_cleanup_unverified";
          entry.runtimeDrainStarted = true;
          options.admission.beginDraining();
          const initialCleanup = (async () => {
            entry.cleanupCodes = [...(await cleanupEntry(entry, false))];
          })();
          entry.launchRecoveryPromise = initialCleanup;
          try {
            await initialCleanup;
          } finally {
            if (entry.launchRecoveryPromise === initialCleanup) {
              entry.launchRecoveryPromise = undefined;
            }
          }
          void recoverSettledLaunch(entry).catch(() => undefined);
          throw new SessionRegistryError(
            request.replay === null
              ? "browser_unavailable"
              : "replay_unavailable",
            "Chromium launch cleanup is unverified",
            { cause: error, cleanupCodes: entry.cleanupCodes },
          );
        }
        entry.context = context;
        entry.launchAttempt = undefined;
        try {
          assertProvisioningAdmitted(entry);
          const remaining = Math.max(
            1,
            Math.min(operationTimeoutMs, entry.deadlineAtMs - now()),
          );
          if (context.setDefaultTimeout !== undefined) {
            runAdmitted(entry, () => context.setDefaultTimeout!(remaining));
          }
          if (context.setDefaultNavigationTimeout !== undefined) {
            runAdmitted(entry, () =>
              context.setDefaultNavigationTimeout!(remaining),
            );
          }
          if (replayState !== null) {
            await runWithinDeadline(entry, () =>
              context.setStorageState(replayState.storageState),
            );
            const exported: unknown = await runWithinDeadline(entry, () =>
              context.storageState({ indexedDB: true }),
            );
            assertProvisioningAdmitted(entry);
            verifySemanticallyEquivalentStorageState(
              exported,
              replayState.storageState,
            );
            assertProvisioningAdmitted(entry);
          }
          runAdmitted(entry, () => gate.assertZeroViolations());
          runAdmitted(entry, () => gate.open());
          const page = await runWithinDeadline(entry, () =>
            acquireLaunchOwnedPage(context),
          );
          if (request.settings.cookies.length !== 0) {
            if (context.addCookies === undefined) {
              throw new ReplayRestoreError(
                "replay_unsupported",
                "context cannot install requested cookies",
              );
            }
            await runWithinDeadline(entry, () =>
              context.addCookies!(request.settings.cookies),
            );
          }
          const target = replayState?.checkpoint.finalUrl ?? request.initialUrl;
          if (target !== "about:blank") {
            const positiveControl = runAdmitted(entry, () =>
              gate.markPositiveControlBaseline(target),
            );
            await runWithinDeadline(entry, () =>
              page.goto(target, {
                timeout: Math.max(
                  1,
                  Math.min(operationTimeoutMs, entry.deadlineAtMs - now()),
                ),
              }),
            );
            runAdmitted(entry, () =>
              gate.assertPositiveControl(positiveControl, target),
            );
          }
          const title = await runWithinDeadline(entry, () => page.title());
          const body =
            (await runWithinDeadline(entry, () => page.textContent("body"))) ??
            "";
          const pageUrl = runAdmitted(entry, () => page.url());
          if (replayState !== null) {
            if (
              pageUrl !== replayState.checkpoint.fingerprint.finalUrl ||
              sha256(title) !==
                replayState.checkpoint.fingerprint.titleSha256 ||
              sha256(body) !== replayState.checkpoint.fingerprint.bodyTextSha256
            ) {
              throw new ReplayRestoreError(
                "replay_unavailable",
                "replay fingerprint differs",
              );
            }
          }
          entry.page = page;
          entry.pageState = {
            url: pageUrl,
            title: Array.from(title).slice(0, 4_096).join(""),
            snapshotExcerpt: Array.from(body).slice(0, 40_000).join(""),
          };
          if (context.tracing === undefined) {
            throw asError(
              "browser_unavailable",
              "Chromium tracing is unavailable",
            );
          }
          await runWithinDeadline(entry, () =>
            context.tracing!.start({
              screenshots: true,
              snapshots: true,
              sources: false,
            }),
          );
          entry.traceStarted = true;
          entry.recordingProducer = await runWithinDeadline(entry, () =>
            createRecordingProducer(page as Page, {
              width: Math.min(request.settings.viewport.width, 1_280),
              height: Math.min(request.settings.viewport.height, 720),
              frameRate: 10,
              maximumBytes: MAX_CAPTURE_BYTES,
              quality: 70,
            }),
          );
          assertProvisioningAdmitted(entry);
          entry.state = "ready";
          entry.admission = "open";
          return publicSession(entry);
        } catch (error) {
          return await failAfterContext(
            entry,
            request.replay === null
              ? "browser_unavailable"
              : "replay_unavailable",
            error,
          );
        }
      } catch (error) {
        if (entry.state === "cleanup_failed") throw error;
        if (entry.context !== undefined) throw error;
        const cleanupCodes = await cleanupEntry(entry, true);
        if (cleanupCodes.length === 0) {
          entriesByRuntime.delete(runtimeSessionId);
          runtimeByRequest.delete(request.sessionId);
        } else {
          entry.state = "cleanup_failed";
          entry.admission = "closed";
          entry.cleanupDetail = "acquisition_cleanup_failed";
          entry.cleanupCodes = [...cleanupCodes];
        }
        const category =
          error instanceof SessionRegistryError
            ? error.category
            : request.replay === null
              ? "browser_unavailable"
              : "replay_unavailable";
        throw new SessionRegistryError(category, "session acquisition failed", {
          cause: error,
          cleanupCodes,
        });
      }
    },

    get(runtimeSessionId) {
      const entry = entriesByRuntime.get(runtimeSessionId);
      if (
        entry === undefined ||
        isExpired(entry) ||
        (entry.state !== "ready" &&
          entry.state !== "executing" &&
          entry.state !== "stopping")
      ) {
        return undefined;
      }
      return publicSession(entry);
    },

    touch(runtimeSessionId) {
      const entry = requireEntry(runtimeSessionId);
      if (entry.state !== "ready" && entry.state !== "executing") {
        throw asError("session_not_found", "session cannot be touched");
      }
      if (isExpired(entry)) {
        throw asError("session_not_found", "session has expired");
      }
      entry.idleExpiresAtMs = Math.min(
        entry.expiresAtMs,
        now() + entry.request.activityTtlSeconds * 1_000,
      );
      entry.deadlineAtMs = Math.min(entry.expiresAtMs, entry.idleExpiresAtMs);
      entry.sessionVersion += 1;
      return publicSession(entry);
    },

    async withWriter(runtimeSessionId, operation) {
      const entry = requireEntry(runtimeSessionId);
      if (entry.writerHeld) {
        throw asError("concurrency_exceeded", "session writer is already held");
      }
      if (isExpired(entry)) {
        throw asError("session_not_found", "session has expired");
      }
      if (entry.state !== "ready") {
        throw asError(
          "concurrency_exceeded",
          "session does not accept a writer",
        );
      }
      assertEntryAdmitted(entry);
      entry.writerHeld = true;
      entry.state = "executing";
      const writerAbort = new AbortController();
      entry.writerAbort = writerAbort;
      let settleWriter!: () => void;
      const writerSettlement = new Promise<void>(resolve => {
        settleWriter = resolve;
      });
      entry.writerSettlement = writerSettlement;
      try {
        const result = await operation(writerAbort.signal);
        assertEntryAdmitted(entry);
        return result;
      } finally {
        entry.writerHeld = false;
        if (entry.writerAbort === writerAbort) {
          entry.writerAbort = undefined;
        }
        settleWriter();
        if (entry.writerSettlement === writerSettlement) {
          entry.writerSettlement = undefined;
        }
        if (entry.state === "executing") entry.state = "ready";
      }
    },

    async withRuntime(runtimeSessionId, mode, operation) {
      if (mode !== "passive" && mode !== "writer") {
        throw asError("invalid_request", "runtime lease mode is invalid");
      }
      const entry = requireEntry(runtimeSessionId);
      const execute = async () => {
        assertEntryAdmitted(entry);
        const token = Object.freeze({}) as SessionRuntimeLease;
        const leaseRecord: RuntimeLeaseRecord = {
          entry,
          state: "active",
          controller: new AbortController(),
          channels: new Set(),
        };
        runtimeLeaseRecords.set(token, leaseRecord);
        entry.runtimeLeases.add(leaseRecord);
        try {
          return await operation(token);
        } finally {
          await revokeRuntimeLease(leaseRecord);
        }
      };
      const flight =
        mode === "writer"
          ? registry.withWriter(runtimeSessionId, execute)
          : execute();
      const settlement = flight.then(
        () => undefined,
        () => undefined,
      );
      entry.runtimeLeaseFlights.add(settlement);
      void settlement.then(() => entry.runtimeLeaseFlights.delete(settlement));
      return flight;
    },

    async executeAction(runtimeSessionId, input) {
      const entry = requireEntry(runtimeSessionId);
      assertEntryAdmitted(entry);
      const request = actionExecutionRequestSchema.parse(input);
      return executeCachedAction({
        cache: entry.actionCache,
        request,
        withWriter: operation =>
          registry.withWriter(runtimeSessionId, async signal => {
            await applyAuthority(
              entry,
              request.expectedSessionVersion,
              request.allowedDomains,
            );
            return operation(signal);
          }),
        executeOperation: (operation, signal) =>
          runWithinDeadline(
            entry,
            async () => {
              if (entry.operationSession === undefined) {
                if (entry.page === undefined) {
                  throw asError(
                    "session_not_found",
                    "session has no active page",
                  );
                }
                entry.operationSession = createBrowserOperationSession({
                  page: entry.page,
                  allowedDomains: entry.allowedDomains,
                  initialOrigin: entry.initialOrigin,
                });
              }
              return entry.operationSession.execute(operation);
            },
            signal,
          ),
        currentSessionVersion: () => entry.sessionVersion,
        currentPage: () => {
          if (entry.pageState === undefined) {
            throw asError(
              "session_not_found",
              "session has no public page state",
            );
          }
          return { ...entry.pageState };
        },
        commitSuccess: (execution) => {
          entry.pageState = { ...execution.page };
          entry.sessionVersion += 1;
          entry.idleExpiresAtMs = Math.min(
            entry.expiresAtMs,
            now() + entry.request.activityTtlSeconds * 1_000,
          );
          entry.deadlineAtMs = Math.min(
            entry.expiresAtMs,
            entry.idleExpiresAtMs,
          );
          return entry.sessionVersion;
        },
        closeAmbiguous: async () => {
          await registry.close(runtimeSessionId, "error");
        },
      });
    },

    async extendAuthority(
      runtimeSessionId,
      expectedSessionVersion,
      allowedDomains,
    ) {
      const entry = requireEntry(runtimeSessionId);
      await registry.withWriter(runtimeSessionId, () =>
        applyAuthority(entry, expectedSessionVersion, allowedDomains),
      );
      return publicSession(entry);
    },

    async close(runtimeSessionId, reason) {
      const prior = closed.get(runtimeSessionId);
      if (prior !== undefined) return prior;
      const existingFlight = closeFlights.get(runtimeSessionId);
      if (existingFlight !== undefined) return existingFlight;
      const entry = requireEntry(runtimeSessionId);
      if (entry.writerHeld) {
        throw asError(
          "concurrency_exceeded",
          "session writer must finish before close",
        );
      }
      const flight = (async (): Promise<ClosedSession> => {
        const normalClose =
          entry.normalClose ??
          (entry.normalClose = {
            reason,
            preparedProfile: null,
          });
        entry.state = "stopping";
        entry.admission = "closed";
        const cleanupCodes = [...(await cleanupEntry(entry, false))];
        const cleanupFailures: unknown[] = [];
        if (cleanupCodes.length === 0 && entry.work !== undefined) {
          if (entry.work.mode === "writer" && reason !== "handoff") {
            try {
              normalClose.preparedProfile ??=
                await options.profileStore.prepareWorkingCopy(entry.work);
              entry.work = undefined;
            } catch (cause) {
              cleanupCodes.push("profile_prepare_failed");
              cleanupFailures.push(cause);
            }
          } else {
            try {
              await options.profileStore.discardWorkingCopy(entry.work);
              entry.work = undefined;
            } catch (cause) {
              cleanupCodes.push("profile_discard_failed");
              cleanupFailures.push(cause);
            }
          }
        }
        if (cleanupCodes.length !== 0) {
          entry.state = "cleanup_failed";
          entry.cleanupDetail = "resource_cleanup_failed";
          entry.cleanupCodes = [...new Set(cleanupCodes)];
          throw new SessionRegistryError(
            "browser_unavailable",
            `session close cleanup failed: ${entry.cleanupCodes.join(",")}`,
            {
              cause:
                cleanupFailures.length === 1
                  ? cleanupFailures[0]
                  : cleanupFailures.length > 1
                    ? new AggregateError(cleanupFailures)
                    : undefined,
              cleanupCodes: entry.cleanupCodes,
            },
          );
        }
        entry.sessionVersion += 1;
        const result = Object.freeze(
          closedSessionV1Schema.parse({
            version: 1 as const,
            runtimeSessionId,
            closed: true as const,
            sessionVersion: entry.sessionVersion,
            preparedProfile: normalClose.preparedProfile,
          }),
        );
        rememberClosed(runtimeSessionId, result);
        entry.closeResult = result;
        entriesByRuntime.delete(runtimeSessionId);
        runtimeByRequest.delete(entry.request.sessionId);
        return result;
      })();
      closeFlights.set(runtimeSessionId, flight);
      try {
        return await flight;
      } finally {
        closeFlights.delete(runtimeSessionId);
      }
    },

    async sweepExpired() {
      const at = now();
      const expired = [...entriesByRuntime.values()].filter(
        (entry) =>
          (entry.state === "ready" || entry.state === "executing") &&
          (at >= entry.idleExpiresAtMs || at >= entry.expiresAtMs),
      );
      for (const entry of expired) {
        await registry
          .close(entry.runtimeSessionId, "expired")
          .catch(() => undefined);
      }
    },

    async sweepCleanupFailed() {
      for (const entry of [...entriesByRuntime.values()]) {
        if (entry.state !== "cleanup_failed") continue;
        await recoverSettledLaunch(entry);
        if (!entriesByRuntime.has(entry.runtimeSessionId)) continue;
        if (entry.normalClose !== undefined) {
          await registry
            .close(entry.runtimeSessionId, entry.normalClose.reason)
            .catch(() => undefined);
          continue;
        }
        const cleanupUnverified =
          entry.cleanupDetail === "launch_cleanup_unverified" ||
          entry.cleanupDetail === "profile_acquisition_cleanup_unverified";
        const cleanupCodes = await cleanupEntry(entry, !cleanupUnverified);
        if (cleanupUnverified) continue;
        if (cleanupCodes.length === 0) {
          entriesByRuntime.delete(entry.runtimeSessionId);
          runtimeByRequest.delete(entry.request.sessionId);
        }
      }
    },

    async drainAll(_reason, admission) {
      if (!registryAdmissionOpen && entriesByRuntime.size === 0) return;
      registryAdmissionOpen = false;
      options.admission.beginDraining();
      admission?.assertWaveActive();
      for (const entry of entriesByRuntime.values()) {
        entry.admission = "closed";
        for (const lease of entry.runtimeLeases) lease.controller.abort();
        entry.writerAbort?.abort(
          asError("browser_unavailable", "session writer authority ended"),
        );
      }
      const failures: unknown[] = [];
      for (const entry of [...entriesByRuntime.values()]) {
        admission?.assertWaveActive();
        const runtimeSettlement = Promise.allSettled([
          ...entry.runtimeLeaseFlights,
        ]).then(() => undefined);
        if (!(await observeWithin(runtimeSettlement))) {
          failures.push(
            new Error(
              `runtime lease drain timed out for ${entry.runtimeSessionId}`,
            ),
          );
        }
        const writerSettlement = entry.writerSettlement;
        if (
          writerSettlement !== undefined &&
          !(await observeWithin(
            writerSettlement,
            operationTimeoutMs + cleanupTimeoutMs,
          ))
        ) {
          failures.push(
            new Error(`writer drain timed out for ${entry.runtimeSessionId}`),
          );
          continue;
        }
        if (entry.writerHeld) {
          failures.push(
            new Error(
              `writer drain remained held for ${entry.runtimeSessionId}`,
            ),
          );
          continue;
        }
        try {
          await registry.close(entry.runtimeSessionId, _reason);
        } catch (error) {
          failures.push(error);
        }
      }
      admission?.assertWaveActive();
      if (failures.length !== 0 || entriesByRuntime.size !== 0) {
        throw new SessionRegistryError(
          "browser_unavailable",
          "session registry drain is unverified",
          {
            cause:
              failures.length === 1
                ? failures[0]
                : new AggregateError(failures),
            cleanupCodes: ["runtime_drain_failed"],
          },
        );
      }
    },

    entries() {
      return [...entriesByRuntime.values()].map((entry) => ({
        runtimeSessionId: entry.runtimeSessionId,
        state: entry.state,
        admission: entry.admission,
        ...(entry.cleanupDetail === undefined
          ? {}
          : { cleanupDetail: entry.cleanupDetail }),
        cleanupCodes: [...entry.cleanupCodes],
        ...(entry.launchAttempt === undefined
          ? {}
          : { launchAttempt: { ...entry.launchAttempt } }),
      }));
    },
  };

  return registry;
}
