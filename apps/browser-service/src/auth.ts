import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import { BrowserServiceError } from "./errors.js";

export const PRIVATE_AUTH_HEADERS = {
  authorization: "authorization",
  correlationId: "x-firecrawl-correlation-id",
  deadline: "x-firecrawl-deadline",
} as const;

export const PRIVATE_FENCING_HEADERS = {
  processNonce: "x-firecrawl-process-nonce",
  controlGenerationNonce: "x-firecrawl-control-generation-nonce",
} as const;

export const AUTH_BEARER_MAX_BYTES = 4_096;
export const AUTH_CORRELATION_MIN_CHARS = 1;
export const AUTH_CORRELATION_MAX_CHARS = 128;
export const AUTH_DEADLINE_MAX_MS = 5 * 60 * 1_000;
export const AUTH_CUSTOM_CONSTANTS = {
  authBearerMaxBytes: AUTH_BEARER_MAX_BYTES,
  authCorrelationMinChars: AUTH_CORRELATION_MIN_CHARS,
  authCorrelationMaxChars: AUTH_CORRELATION_MAX_CHARS,
  authCorrelationPrintableAscii: "0x20..0x7e",
  authDeadlineMaxMs: AUTH_DEADLINE_MAX_MS,
  authDeadlineCanonicalUtc: true,
} as const;
export const AUTH_SEMANTIC_RULE_REGISTRY = {
  private_auth_v1: {
    target: "authorizePrivateRequest",
    constantKeys: [
      "authBearerMaxBytes",
      "authCorrelationMinChars",
      "authCorrelationMaxChars",
      "authCorrelationPrintableAscii",
      "authDeadlineMaxMs",
      "authDeadlineCanonicalUtc",
    ],
    behaviorKeys: [
      "exact_bearer_secret",
      "printable_ascii_correlation_id",
      "canonical_future_deadline",
    ],
  },
} as const;

export type PrivateRequestHeaders = {
  authorization: string | undefined;
  correlationId: string | undefined;
  deadline: string | undefined;
};

export type AuthorizedPrivateRequest = {
  correlationId: string;
  deadline: Date;
};

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const maximum = Math.max(actualBytes.length, expectedBytes.length);
  const paddedActual = Buffer.alloc(maximum);
  const paddedExpected = Buffer.alloc(maximum);
  actualBytes.copy(paddedActual);
  expectedBytes.copy(paddedExpected);
  return (
    timingSafeEqual(paddedActual, paddedExpected) &&
    actualBytes.length === expectedBytes.length
  );
}

export function authorizePrivateRequest(
  headers: PrivateRequestHeaders,
  serviceKey: string,
): AuthorizedPrivateRequest {
  const authorization = headers.authorization;
  if (
    authorization === undefined ||
    Buffer.byteLength(authorization, "utf8") > AUTH_BEARER_MAX_BYTES ||
    !authorization.startsWith("Bearer ") ||
    !equalSecret(authorization.slice("Bearer ".length), serviceKey)
  ) {
    throw new BrowserServiceError(
      "unauthorized",
      "unauthorized private request",
    );
  }

  const correlationId = headers.correlationId;
  if (
    correlationId === undefined ||
    correlationId.length < AUTH_CORRELATION_MIN_CHARS ||
    correlationId.length > AUTH_CORRELATION_MAX_CHARS ||
    !/^[\x20-\x7e]+$/.test(correlationId)
  ) {
    throw new BrowserServiceError("invalid_request", "invalid correlation ID");
  }

  const deadlineValue = headers.deadline;
  const deadlineMs =
    deadlineValue === undefined ? Number.NaN : Date.parse(deadlineValue);
  const now = Date.now();
  if (
    deadlineValue === undefined ||
    !Number.isFinite(deadlineMs) ||
    new Date(deadlineMs).toISOString() !== deadlineValue ||
    deadlineMs <= now ||
    deadlineMs > now + AUTH_DEADLINE_MAX_MS
  ) {
    throw new BrowserServiceError(
      "deadline_expired",
      "invalid request deadline",
    );
  }

  return { correlationId, deadline: new Date(deadlineMs) };
}
