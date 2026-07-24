import { createHash, randomUUID as systemRandomUUID } from "node:crypto";

import { chromium, devices } from "playwright";

import {
  closedSessionV1Schema,
  createSessionV1Schema,
  type CreateSessionV1,
  type ClosedSessionV1,
  type SessionV1,
} from "./contracts.js";
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

type PageLike = {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  textContent(selector: string): Promise<string | null>;
};

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
  reason: "requested" | "expired" | "error" | "shutdown";
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
  initialOrigin: string;
  allowedDomains: readonly string[];
  learnedOrigins: Set<string>;
  deadlineAtMs: number;
  devToolsEndpoint: string | null;
  streamHub: object;
  work: WorkingProfile | undefined;
  proxy: EgressProxy | undefined;
  context: ContextLike | undefined;
  chromiumAttachment: AttachedChromium | undefined;
  page: PageLike | undefined;
  pageState:
    | { url: string; title: string; snapshotExcerpt: string }
    | undefined;
  writerHeld: boolean;
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
    operation: () => Promise<T>,
  ): Promise<T>;
  close(
    runtimeSessionId: string,
    reason: "requested" | "expired" | "error" | "shutdown",
  ): Promise<ClosedSession>;
  sweepExpired(): Promise<void>;
  sweepCleanupFailed(): Promise<void>;
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
    request.initialUrl,
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
  ): Promise<T> {
    assertEntryAdmitted(entry);
    const timeoutMs = Math.min(operationTimeoutMs, entry.deadlineAtMs - now());
    if (timeoutMs <= 0) throw new Error("session deadline exceeded");
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      throw error;
    }
    try {
      const result = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("session operation timed out")),
            timeoutMs,
          );
        }),
      ]);
      assertEntryAdmitted(entry);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function runAdmitted<T>(entry: RegistryEntry, operation: () => T): T {
    assertEntryAdmitted(entry);
    const result = operation();
    assertEntryAdmitted(entry);
    return result;
  }

  async function observeWithin(promise: Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(resolve, cleanupTimeoutMs, false);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function requireReady(): ReadyProfileRootBinding {
    return options.admission.requireReady(options.binding);
  }

  function requireEntry(runtimeSessionId: string): RegistryEntry {
    const entry = entriesByRuntime.get(runtimeSessionId);
    if (entry === undefined)
      throw asError("session_not_found", "session not found");
    return entry;
  }

  function assertEntryAdmitted(entry: RegistryEntry): void {
    requireReady();
    const deadline = Math.min(entry.expiresAtMs, entry.idleExpiresAtMs);
    if (now() >= deadline) throw new Error("session deadline exceeded");
    entry.deadlineAtMs = deadline;
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
    let contextClosed = false;
    try {
      contextClosed = await closeContext(entry);
    } catch {
      contextClosed = false;
    }
    if (!contextClosed) cleanupCodes.push("chromium_close_failed");
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
        entry.chromiumAttachment =
          settlement.error.attachment as unknown as AttachedChromium;
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
        initialOrigin: new URL(request.initialUrl).origin,
        allowedDomains: Object.freeze([...request.allowedDomains]),
        learnedOrigins: new Set([new URL(request.initialUrl).origin]),
        deadlineAtMs: creationDeadlineAtMs,
        devToolsEndpoint: null,
        streamHub: Object.freeze({}),
        writerHeld: false,
        contextCloseVerified: false,
        runtimeDrainStarted: false,
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
          assertEntryAdmitted(entry);
          entry.work = await options.profileStore.createWorkingCopy(
            profileId,
            base,
            mode,
            request.sessionId,
          );
          assertEntryAdmitted(entry);
        } catch (error) {
          if (
            error instanceof ProfileStoreError &&
            error.retainedWork !== undefined
          ) {
            entry.work = error.retainedWork;
          }
          if (
            error instanceof ProfileStoreError &&
            error.cleanupUnverified
          ) {
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
        assertEntryAdmitted(entry);
        entry.proxy = await createProxy({
          restoreGate: createRestoreGate(),
          allowedDomains: request.allowedDomains,
          deadlineAtMs: () =>
            Math.min(entry.expiresAtMs, entry.idleExpiresAtMs),
        });
        assertEntryAdmitted(entry);
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
        assertEntryAdmitted(entry);
        entry.launchAttempt = { state: "owned", publicProcessHandle: null };
        let context: ContextLike;
        try {
          const boundedLaunchMs = Math.max(
            1,
            Math.min(launchTimeoutMs, launchRemainingMs),
          );
          const workingGeneration =
            options.profileStore.workingGeneration(entry.work);
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
          assertEntryAdmitted(entry);
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
            await runWithinDeadline(
              entry,
              () => context.setStorageState(replayState.storageState),
            );
            const exported: unknown = await runWithinDeadline(
              entry,
              () => context.storageState({ indexedDB: true }),
            );
            assertEntryAdmitted(entry);
            verifySemanticallyEquivalentStorageState(
              exported,
              replayState.storageState,
            );
            assertEntryAdmitted(entry);
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
            await runWithinDeadline(
              entry,
              () => context.addCookies!(request.settings.cookies),
            );
          }
          const target = replayState?.checkpoint.finalUrl ?? request.initialUrl;
          const positiveControl = runAdmitted(entry, () =>
            gate.markPositiveControlBaseline(target),
          );
          await runWithinDeadline(
            entry,
            () =>
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
          assertEntryAdmitted(entry);
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
      try {
        const result = await operation();
        assertEntryAdmitted(entry);
        return result;
      } finally {
        entry.writerHeld = false;
        if (entry.state === "executing") entry.state = "ready";
      }
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
        if (cleanupCodes.length === 0 && entry.work !== undefined) {
          if (entry.work.mode === "writer") {
            try {
              normalClose.preparedProfile ??=
                await options.profileStore.prepareWorkingCopy(entry.work);
              await options.profileStore.finalizePreparedGeneration(
                normalClose.preparedProfile,
              );
              entry.work = undefined;
            } catch {
              cleanupCodes.push(
                normalClose.preparedProfile === null
                  ? "profile_prepare_failed"
                  : "profile_finalize_failed",
              );
            }
          } else {
            try {
              await options.profileStore.discardWorkingCopy(entry.work);
              entry.work = undefined;
            } catch {
              cleanupCodes.push("profile_discard_failed");
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
            { cleanupCodes: entry.cleanupCodes },
          );
        }
        entry.sessionVersion += 1;
        const result = Object.freeze(closedSessionV1Schema.parse({
          version: 1 as const,
          runtimeSessionId,
          closed: true as const,
          sessionVersion: entry.sessionVersion,
          preparedProfile: normalClose.preparedProfile,
        }));
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
