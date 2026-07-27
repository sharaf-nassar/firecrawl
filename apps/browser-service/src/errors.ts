import {
  PRIVATE_ERROR_MAX_BYTES,
  PRIVATE_ERROR_MAX_MESSAGE_CHARS,
  privateErrorV1Schema,
} from "./contracts.js";

export const BROWSER_SERVICE_ERROR_STATUS = {
  browser_service_runtime_mismatch: 503,
  browser_unavailable: 503,
  unauthorized: 401,
  invalid_request: 400,
  request_too_large: 413,
  deadline_expired: 408,
  control_generation_required: 503,
  control_generation_in_progress: 409,
  control_generation_conflict: 409,
  control_generation_superseded: 409,
  control_generation_mismatch: 409,
  control_generation_drain_failed: 503,
  control_generation_history_exhausted: 503,
  reconciliation_required: 503,
  reconciliation_in_progress: 503,
  reconciliation_nonce_mismatch: 409,
  reconciliation_conflicting_replay: 409,
  reconciliation_snapshot_invalid: 400,
  reconciliation_snapshot_too_large: 413,
  reconciliation_reference_missing: 409,
  reconciliation_reference_corrupt: 409,
  reconciliation_filesystem_unsafe: 503,
  reconciliation_deadline_exceeded: 408,
  reconciliation_execution_failed: 503,
  reconciliation_cleanup_failed: 503,
  profile_prepare_failed: 503,
  profile_finalize_failed: 409,
  profile_discard_failed: 409,
} as const;

export type BrowserServiceErrorCategory =
  keyof typeof BROWSER_SERVICE_ERROR_STATUS;

export const BROWSER_SERVICE_INTERNAL_DETAILS = [
  "close_failed",
  "close_deadline_exceeded",
  "drain_invariant_failed",
] as const;
export type BrowserServiceInternalDetail =
  (typeof BROWSER_SERVICE_INTERNAL_DETAILS)[number];
export const ERROR_CUSTOM_CONSTANTS = {
  internalErrorDetailAllowlist: BROWSER_SERVICE_INTERNAL_DETAILS,
  privateErrorMaxBytes: PRIVATE_ERROR_MAX_BYTES,
  privateErrorMaxMessageChars: PRIVATE_ERROR_MAX_MESSAGE_CHARS,
} as const;
export const ERROR_SEMANTIC_RULE_REGISTRY = {
  internal_error_detail_v1: {
    target: "BrowserServiceError",
    constantKeys: ["internalErrorDetailAllowlist"],
    behaviorKeys: ["internal_detail_allowlist_enforced"],
  },
} as const;

function toSafeText(message: string): string {
  let result = "";
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = message.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += message.charAt(index) + message.charAt(index + 1);
        index += 1;
      } else {
        result += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "�";
    } else if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      result += " ";
    } else {
      result += message.charAt(index);
    }
  }
  return Array.from(result).slice(0, PRIVATE_ERROR_MAX_MESSAGE_CHARS).join("");
}

function sanitizeMessage(
  category: BrowserServiceErrorCategory,
  message: string,
): string {
  const characters = Array.from(toSafeText(message));
  while (true) {
    const candidate = characters.join("");
    if (
      privateErrorV1Schema.safeParse({
        version: 1,
        category,
        message: candidate,
      }).success
    ) {
      return candidate;
    }
    if (characters.length === 0) return "";
    characters.pop();
  }
}

export class BrowserServiceError extends Error {
  readonly category: BrowserServiceErrorCategory;
  readonly statusCode: number;
  readonly detail: BrowserServiceInternalDetail | undefined;
  readonly #response: { version: 1; category: string; message: string };

  constructor(
    category: BrowserServiceErrorCategory,
    message: string,
    options: { detail?: BrowserServiceInternalDetail } = {},
  ) {
    if (
      options.detail !== undefined &&
      !BROWSER_SERVICE_INTERNAL_DETAILS.includes(options.detail)
    ) {
      throw new TypeError("browser service error detail is not allowlisted");
    }
    const sanitized = sanitizeMessage(category, message);
    super(sanitized);
    this.name = "BrowserServiceError";
    this.category = category;
    this.statusCode = BROWSER_SERVICE_ERROR_STATUS[category];
    this.detail = options.detail;
    this.#response = Object.freeze({
      version: 1,
      category,
      message: sanitized,
    });
  }

  toResponse(): { version: 1; category: string; message: string } {
    return { ...this.#response };
  }
}

export function browserServiceError(
  category: BrowserServiceErrorCategory,
  message: string,
): BrowserServiceError {
  return new BrowserServiceError(category, message);
}
