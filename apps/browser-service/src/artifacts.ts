import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  ARTIFACT_METADATA_HEADERS,
  MAX_ARTIFACT_BYTES,
  MAX_RUN_ARTIFACT_BYTES,
  MAX_RUN_ARTIFACTS,
  artifactMetadataV1Schema,
  fetchArtifactV1Schema,
  type ArtifactMetadataV1,
  type FetchArtifactV1,
} from "./contracts.js";
import {
  captureSessionArtifact as captureSessionArtifactDefault,
  SessionRegistryError,
  type SessionRegistry,
  type SessionRuntimeLease,
} from "./session-registry.js";
import type { ControlGenerationBinding } from "./startup-state.js";
import { browserServiceError } from "./errors.js";

const STREAM_CHUNK_BYTES = 64 * 1024;

type ArtifactRegistry = Pick<
  SessionRegistry,
  "close" | "get" | "withRuntime"
>;

type ArtifactCapture = (
  lease: SessionRuntimeLease,
  input: FetchArtifactV1,
) => Promise<Readonly<{ contentType: string; bytes: Uint8Array }>>;

export type ArtifactSessionBinding = Readonly<
  ControlGenerationBinding & {
    runtimeSessionId: string;
  }
>;

export type ArtifactHeaders = Readonly<
  Record<(typeof ARTIFACT_METADATA_HEADERS)[keyof typeof ARTIFACT_METADATA_HEADERS], string>
>;

export type CapturedArtifact = Readonly<{
  metadata: ArtifactMetadataV1;
  stream: Readable;
}>;

type Sha256Accumulator = {
  update(bytes: Uint8Array): void;
  digest(): string;
};

type SessionArtifacts = {
  readonly binding: ArtifactSessionBinding;
  readonly artifactIds: Set<string>;
  readonly streams: Set<Readable>;
  artifactCount: number;
  artifactBytes: number;
  closed: boolean;
  tail: Promise<void>;
};

export type ArtifactService = Readonly<{
  capture(
    binding: ArtifactSessionBinding,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<CapturedArtifact>;
  releaseSession(binding: ArtifactSessionBinding): void;
  sweepExpired(): void;
  drainAll(): void;
}>;

type ArtifactServiceOptions = Readonly<{
  registry: ArtifactRegistry;
  captureSessionArtifact?: ArtifactCapture;
  createSha256?: () => Sha256Accumulator;
}>;

function defaultSha256(): Sha256Accumulator {
  const hash = createHash("sha256");
  return {
    update(bytes) {
      hash.update(bytes);
    },
    digest() {
      return hash.digest("hex");
    },
  };
}

function digestBytes(
  bytes: Uint8Array,
  createSha256: () => Sha256Accumulator,
): string {
  const digest = createSha256();
  digest.update(bytes);
  return digest.digest();
}

function sameBinding(
  left: ArtifactSessionBinding,
  right: ArtifactSessionBinding,
): boolean {
  return (
    left.runtimeSessionId === right.runtimeSessionId &&
    left.processNonce === right.processNonce &&
    left.controlGenerationNonce === right.controlGenerationNonce
  );
}

function unavailable(message: string, cause?: unknown): SessionRegistryError {
  return new SessionRegistryError(
    "browser_unavailable",
    message,
    cause === undefined ? {} : { cause },
  );
}

function invalidRequest(message: string): SessionRegistryError {
  return new SessionRegistryError("invalid_request", message);
}

function sessionGone(): SessionRegistryError {
  return new SessionRegistryError(
    "session_not_found",
    "artifact session is no longer available",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("artifact request was aborted", "AbortError");
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

class VerifiedArtifactStream extends Readable {
  readonly #expectedChecksum: string;
  readonly #digest: Sha256Accumulator;
  readonly #onReleased: () => void;
  readonly #onIntegrityFailure: (error: SessionRegistryError) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #abort: (() => void) | undefined;
  #bytes: Uint8Array | undefined;
  #offset = 0;
  #released = false;

  constructor(
    bytes: Uint8Array,
    expectedChecksum: string,
    createSha256: () => Sha256Accumulator,
    signal: AbortSignal | undefined,
    onReleased: () => void,
    onIntegrityFailure: (error: SessionRegistryError) => void,
  ) {
    super({ highWaterMark: STREAM_CHUNK_BYTES });
    this.#bytes = bytes;
    this.#expectedChecksum = expectedChecksum;
    this.#digest = createSha256();
    this.#signal = signal;
    this.#onReleased = onReleased;
    this.#onIntegrityFailure = onIntegrityFailure;
    if (signal !== undefined) {
      this.#abort = () => this.destroy();
      signal.addEventListener("abort", this.#abort, { once: true });
    }
  }

  override _read(): void {
    const bytes = this.#bytes;
    if (bytes === undefined || this.destroyed) return;
    if (this.#signal?.aborted) {
      this.destroy();
      return;
    }
    if (this.#offset === bytes.byteLength) {
      const actual = this.#digest.digest();
      this.#bytes = undefined;
      if (actual !== this.#expectedChecksum) {
        const error = unavailable("artifact stream integrity changed");
        this.destroy(error);
        this.#onIntegrityFailure(error);
        return;
      }
      this.push(null);
      return;
    }
    const end = Math.min(
      this.#offset + STREAM_CHUNK_BYTES,
      bytes.byteLength,
    );
    const chunk = bytes.subarray(this.#offset, end);
    this.#offset = end;
    this.#digest.update(chunk);
    this.push(Buffer.from(chunk));
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#bytes = undefined;
    if (this.#signal !== undefined && this.#abort !== undefined) {
      this.#signal.removeEventListener("abort", this.#abort);
    }
    if (!this.#released) {
      this.#released = true;
      this.#onReleased();
    }
    callback(error);
  }
}

export function artifactMetadataHeaders(
  input: ArtifactMetadataV1,
): ArtifactHeaders {
  const metadata = artifactMetadataV1Schema.parse(input);
  return Object.freeze({
    [ARTIFACT_METADATA_HEADERS.version]: String(metadata.version),
    [ARTIFACT_METADATA_HEADERS.artifactId]: metadata.artifactId,
    [ARTIFACT_METADATA_HEADERS.kind]: metadata.kind,
    [ARTIFACT_METADATA_HEADERS.byteSize]: String(metadata.byteSize),
    [ARTIFACT_METADATA_HEADERS.checksum]: metadata.checksum,
    [ARTIFACT_METADATA_HEADERS.contentType]: metadata.contentType,
    [ARTIFACT_METADATA_HEADERS.contentLength]: String(metadata.byteSize),
  }) as ArtifactHeaders;
}

export function createArtifactService(
  options: ArtifactServiceOptions,
): ArtifactService {
  const captureSessionArtifact =
    options.captureSessionArtifact ?? captureSessionArtifactDefault;
  const createSha256 = options.createSha256 ?? defaultSha256;
  const sessions = new Map<string, SessionArtifacts>();

  function clearState(state: SessionArtifacts): void {
    if (!state.closed) state.closed = true;
    for (const stream of [...state.streams]) stream.destroy();
    state.streams.clear();
    state.artifactIds.clear();
    state.artifactCount = 0;
    state.artifactBytes = 0;
  }

  function releaseState(state: SessionArtifacts): void {
    clearState(state);
    if (sessions.get(state.binding.runtimeSessionId) === state) {
      sessions.delete(state.binding.runtimeSessionId);
    }
  }

  function stateFor(binding: ArtifactSessionBinding): SessionArtifacts {
    const existing = sessions.get(binding.runtimeSessionId);
    if (existing !== undefined) {
      if (!sameBinding(existing.binding, binding)) {
        throw browserServiceError(
          "control_generation_mismatch",
          "artifact session belongs to another control generation",
        );
      }
      if (existing.closed) throw sessionGone();
      return existing;
    }
    const state: SessionArtifacts = {
      binding: Object.freeze({ ...binding }),
      artifactIds: new Set(),
      streams: new Set(),
      artifactCount: 0,
      artifactBytes: 0,
      closed: false,
      tail: Promise.resolve(),
    };
    sessions.set(binding.runtimeSessionId, state);
    return state;
  }

  async function failState(
    state: SessionArtifacts,
    cause: unknown,
  ): Promise<SessionRegistryError> {
    clearState(state);
    try {
      await options.registry.close(state.binding.runtimeSessionId, "error");
    } catch {
      // The original capture ambiguity is the externally stable failure.
    }
    return cause instanceof SessionRegistryError &&
      cause.category === "browser_unavailable"
      ? cause
      : unavailable("artifact capture is unavailable", cause);
  }

  function failStateFromStream(
    state: SessionArtifacts,
    error: SessionRegistryError,
  ): void {
    clearState(state);
    void options.registry
      .close(state.binding.runtimeSessionId, "error")
      .catch(() => undefined);
    void error;
  }

  async function capture(
    binding: ArtifactSessionBinding,
    input: unknown,
    captureOptions: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<CapturedArtifact> {
    const request = fetchArtifactV1Schema.parse(input);
    const state = stateFor(binding);
    let releaseTurn!: () => void;
    const previous = state.tail;
    state.tail = new Promise<void>(resolve => {
      releaseTurn = resolve;
    });
    await previous;
    try {
      if (state.closed || sessions.get(binding.runtimeSessionId) !== state) {
        throw sessionGone();
      }
      if (!sameBinding(state.binding, binding)) {
        throw browserServiceError(
          "control_generation_mismatch",
          "artifact session belongs to another control generation",
        );
      }
      throwIfAborted(captureOptions.signal);
      if (state.artifactIds.has(request.artifactId)) {
        throw invalidRequest("artifact ID was already used for this session");
      }
      if (state.artifactCount >= MAX_RUN_ARTIFACTS) {
        throw invalidRequest("session artifact count limit exceeded");
      }
      if (state.artifactBytes >= MAX_RUN_ARTIFACT_BYTES) {
        throw invalidRequest("session artifact byte limit exceeded");
      }

      let produced: Readonly<{ contentType: string; bytes: Uint8Array }>;
      let producerStarted = false;
      try {
        produced = await options.registry.withRuntime(
          binding.runtimeSessionId,
          "writer",
          lease => {
            throwIfAborted(captureOptions.signal);
            producerStarted = true;
            return captureSessionArtifact(lease, request);
          },
        );
      } catch (cause) {
        if (!producerStarted && isAbortError(cause)) throw cause;
        if (
          !producerStarted &&
          cause instanceof SessionRegistryError &&
          cause.category === "session_not_found"
        ) {
          releaseState(state);
          throw cause;
        }
        throw await failState(state, cause);
      }
      try {
        if (captureOptions.signal?.aborted) {
          throw unavailable("artifact request ended after capture began");
        }
        if (state.closed || sessions.get(binding.runtimeSessionId) !== state) {
          throw unavailable("artifact session ended after capture began");
        }
        if (
          !(produced.bytes instanceof Uint8Array) ||
          produced.bytes.byteLength === 0 ||
          produced.bytes.byteLength > MAX_ARTIFACT_BYTES
        ) {
          throw unavailable("artifact exceeds its byte limit");
        }
        if (
          state.artifactBytes + produced.bytes.byteLength >
          MAX_RUN_ARTIFACT_BYTES
        ) {
          throw unavailable("session artifact byte limit exceeded");
        }

        const bytes = Uint8Array.from(produced.bytes);
        const metadata = artifactMetadataV1Schema.parse({
          version: 1,
          artifactId: request.artifactId,
          kind: request.kind,
          contentType: produced.contentType,
          byteSize: bytes.byteLength,
          checksum: digestBytes(bytes, createSha256),
        });
        if (captureOptions.signal?.aborted) {
          throw unavailable("artifact request ended after capture began");
        }
        let stream!: VerifiedArtifactStream;
        stream = new VerifiedArtifactStream(
          bytes,
          metadata.checksum,
          createSha256,
          captureOptions.signal,
          () => state.streams.delete(stream),
          error => failStateFromStream(state, error),
        );
        if (captureOptions.signal?.aborted) {
          stream.destroy();
          throw unavailable("artifact request ended after capture began");
        }
        state.artifactIds.add(metadata.artifactId);
        state.artifactCount += 1;
        state.artifactBytes += metadata.byteSize;
        state.streams.add(stream);
        return Object.freeze({
          metadata: Object.freeze({ ...metadata }),
          stream,
        });
      } catch (cause) {
        throw await failState(state, cause);
      }
    } finally {
      releaseTurn();
    }
  }

  return Object.freeze({
    capture,
    releaseSession(binding) {
      const state = sessions.get(binding.runtimeSessionId);
      if (state !== undefined && sameBinding(state.binding, binding)) {
        releaseState(state);
      }
    },
    sweepExpired() {
      for (const state of sessions.values()) {
        if (options.registry.get(state.binding.runtimeSessionId) === undefined) {
          releaseState(state);
        }
      }
    },
    drainAll() {
      for (const state of [...sessions.values()]) releaseState(state);
    },
  });
}
