import * as winston from "winston";

import { config } from "../config";
import { configDotenv } from "dotenv";
configDotenv();

export const MAX_LOG_METADATA_BYTES = 8 * 1024;

const CONTEXT_KEYS = [
  "level",
  "message",
  "module",
  "method",
  "jobId",
  "requestId",
  "teamId",
  "team_id",
  "scrapeId",
  "crawlId",
  "zeroDataRetention",
  "version",
  "mode",
  "code",
  "status",
  "statusCode",
  "stack",
];

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;

  const suffix = "...[truncated]";
  return (
    Buffer.from(value)
      .subarray(0, maxBytes - Buffer.byteLength(suffix))
      .toString("utf8")
      .replace(/\uFFFD$/, "") + suffix
  );
}

function property(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function summarizeCause(value: unknown, seen: WeakSet<object>, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    return truncateUtf8(String(value), 128);
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= 2) return "[Truncated]";
  seen.add(value);

  const summary: Record<string, unknown> = {};
  for (const key of ["name", "message", "code"]) {
    const field = property(value, key);
    if (["string", "number", "boolean"].includes(typeof field)) {
      summary[key] =
        typeof field === "string" ? truncateUtf8(field, 64) : field;
    }
  }

  const cause = property(value, "cause") ?? property(value, "error");
  if (cause !== undefined) {
    summary.cause = summarizeCause(cause, seen, depth + 1);
  }
  return Object.keys(summary).length > 0 ? summary : "[Object]";
}

function summarizeError(error: Error, seen = new WeakSet<object>()): unknown {
  if (seen.has(error)) return "[Circular]";
  seen.add(error);

  const summary: Record<string, unknown> = {
    name: truncateUtf8(error.name || "Error", 64),
    message: truncateUtf8(error.message, 128),
  };
  if (error.stack) {
    summary.stack = truncateUtf8(error.stack, 512);
  }
  for (const key of ["code", "reason", "engine"]) {
    const value = property(error, key);
    if (["string", "number", "boolean"].includes(typeof value)) {
      summary[key] =
        typeof value === "string" ? truncateUtf8(value, 64) : value;
    }
  }

  const cause = error.cause ?? property(error, "error");
  if (cause !== undefined) {
    summary.cause = summarizeCause(cause, seen, 0);
  }
  return summary;
}

export function serializeLogMetadata(value: unknown): string {
  const source =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : { message: String(value) };
  let entries: [string, unknown][];
  try {
    entries = Object.entries(source);
  } catch {
    return '{"metadataTruncated":true}';
  }

  const errorEntry =
    (value instanceof Error ? ["error", value] : undefined) ??
    entries.find(([key, nested]) => key === "error" && nested !== undefined) ??
    entries.find(([, nested]) => nested instanceof Error);
  const ordered = [
    ...(errorEntry ? [errorEntry] : []),
    ...CONTEXT_KEYS.flatMap(key => {
      const entry = entries.find(([candidate]) => candidate === key);
      return entry ? [entry] : [];
    }),
  ] as [string, unknown][];

  const result: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, nested] of ordered) {
    if (key in result) continue;
    const summarized =
      key === errorEntry?.[0]
        ? nested instanceof Error
          ? summarizeError(nested)
          : summarizeCause(nested, new WeakSet())
        : typeof nested === "string"
          ? truncateUtf8(nested, 500)
          : nested === null || ["number", "boolean"].includes(typeof nested)
            ? nested
            : undefined;
    if (summarized === undefined) continue;
    const candidate = { ...result, [key]: summarized };
    if (
      Buffer.byteLength(JSON.stringify(candidate)) <=
      MAX_LOG_METADATA_BYTES - 32
    ) {
      result[key] = summarized;
    } else {
      truncated = true;
    }
  }
  if (truncated) result.metadataTruncated = true;
  return JSON.stringify(result);
}

const logFormat = winston.format.printf(
  info =>
    `${info.timestamp} ${info.level} [${info.metadata.module ?? ""}:${info.metadata.method ?? ""}]: ${info.message} ${
      info.level.includes("error") || info.level.includes("warn")
        ? JSON.stringify(info.metadata)
        : ""
    }`,
);

// Filter function to prevent logging when zeroDataRetention is true
const zeroDataRetentionFilter = winston.format(info => {
  if (
    info.metadata?.zeroDataRetention === true ||
    info.zeroDataRetention === true
  ) {
    return false; // Don't log this message
  }
  return info;
})();

const boundWarnErrorMetadata = winston.format(info => {
  if (!info.level.includes("error") && !info.level.includes("warn")) {
    return info;
  }

  const bounded = JSON.parse(
    serializeLogMetadata({
      ...info,
      level: info.level,
      message: info.message,
      ...(info instanceof Error ? { error: info } : {}),
    }),
  );
  for (const key of Object.keys(info)) delete info[key];
  Object.assign(info, bounded);
  if ("message" in bounded) {
    Object.defineProperty(info, "message", { enumerable: true });
  }
  return info;
})();

export const logger = winston.createLogger({
  level: config.LOGGING_LEVEL?.toLowerCase() ?? "debug",
  format: winston.format.combine(
    zeroDataRetentionFilter,
    boundWarnErrorMetadata,
    winston.format.json(),
  ),
  transports: [
    ...(config.FIRECRAWL_LOG_TO_FILE
      ? [
          new winston.transports.File({
            filename:
              "firecrawl-" +
              (process.argv[1].includes("worker") ? "worker" : "app") +
              ".log",
            format: winston.format.combine(
              zeroDataRetentionFilter,
              winston.format.json(),
            ),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 3,
            tailable: true,
          }),
        ]
      : []),
    new winston.transports.Console({
      format: winston.format.combine(
        zeroDataRetentionFilter,
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.metadata({
          fillExcept: ["message", "level", "timestamp"],
        }),
        ...((config.ENV === "production" &&
          config.SENTRY_ENVIRONMENT === "dev") ||
        config.ENV !== "production"
          ? [winston.format.colorize(), logFormat]
          : []),
      ),
    }),
  ],
});
