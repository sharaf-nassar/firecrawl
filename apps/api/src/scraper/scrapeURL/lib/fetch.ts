import { Logger } from "winston";
import { z, ZodError } from "zod";
import * as Sentry from "@sentry/node";
import { MockState, saveMock } from "./mock";
import { fireEngineURL } from "../engines/fire-engine/scrape";
import { fetch, Response, FormData, Agent } from "undici";
import { cacheableLookup } from "./cacheableLookup";
import dns from "dns";
import { AbortManagerThrownError } from "./abortManager";

type RobustFetchParams<Schema extends z.Schema<any>> = {
  url: string;
  logger: Logger;
  method: "GET" | "POST" | "DELETE" | "PUT";
  body?: any;
  headers?: Record<string, string>;
  schema?: Schema;
  dontParseResponse?: boolean;
  ignoreResponse?: boolean;
  ignoreFailure?: boolean;
  ignoreFailureStatus?: boolean;
  requestId?: string;
  tryCount?: number;
  tryCooldown?: number;
  mock: MockState | null;
  abort?: AbortSignal;
  useCacheableLookup?: boolean;
  sensitiveResponse?: boolean;
  maxResponseBytes?: number;
};

class ResponseTooLargeError extends Error {
  readonly category = "response_too_large";

  constructor(readonly status: number) {
    super("Response exceeded configured byte limit");
    this.name = "ResponseTooLargeError";
  }
}

async function readResponseText(
  response: Response,
  maximumBytes: number | undefined,
): Promise<string> {
  if (maximumBytes === undefined) return response.text();
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isSafeInteger(Number(contentLength)) &&
    Number(contentLength) > maximumBytes
  ) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(response.status);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map(chunk => Buffer.from(chunk)),
    total,
  ).toString("utf8");
}

const robustAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: {
    lookup: cacheableLookup.lookup,
  },
});

const robustAgentNoLookup = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: {
    lookup: dns.lookup,
  },
});

export async function robustFetch<
  Schema extends z.Schema<any>,
  Output = z.infer<Schema>,
>({
  url,
  logger,
  method = "GET",
  body,
  headers,
  schema,
  ignoreResponse = false,
  ignoreFailure = false,
  ignoreFailureStatus = false,
  requestId = crypto.randomUUID(),
  tryCount = 1,
  tryCooldown,
  mock,
  abort,
  useCacheableLookup = true,
  sensitiveResponse = false,
  maxResponseBytes,
}: RobustFetchParams<Schema>): Promise<Output> {
  abort?.throwIfAborted();
  if (
    sensitiveResponse &&
    (maxResponseBytes === undefined ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes <= 0)
  ) {
    throw new TypeError(
      "sensitiveResponse requires a positive maxResponseBytes",
    );
  }

  const params = {
    url,
    logger,
    method,
    body,
    headers,
    schema,
    ignoreResponse,
    ignoreFailure,
    ignoreFailureStatus,
    tryCount,
    tryCooldown,
    abort,
    sensitiveResponse,
    maxResponseBytes,
  };

  // omit pdf file content from logs
  const logParams = {
    ...params,
    body: sensitiveResponse
      ? "<redacted sensitive request>"
      : body?.input
        ? {
            ...body,
            input: {
              ...body.input,
              file_content: undefined,
            },
          }
        : body?.pdf
          ? {
              ...body,
              pdf: undefined,
            }
          : body,
    headers: sensitiveResponse ? undefined : headers,
    logger: undefined,
  };

  let response: {
    status: number;
    headers: Headers;
    body: string;
  };

  if (mock === null) {
    let request: Response;
    try {
      request = await fetch(url, {
        method,
        headers: {
          ...(body instanceof FormData
            ? {}
            : body !== undefined
              ? {
                  "Content-Type": "application/json",
                }
              : {}),
          ...(headers !== undefined ? headers : {}),
        },
        signal: abort,
        dispatcher: useCacheableLookup ? robustAgent : robustAgentNoLookup,
        ...(body instanceof FormData
          ? {
              body,
            }
          : body !== undefined
            ? {
                body: JSON.stringify(body),
              }
            : {}),
      });
    } catch (error) {
      if (error instanceof AbortManagerThrownError) {
        throw error;
      } else if (!ignoreFailure) {
        Sentry.captureException(error);
        if (tryCount > 1) {
          logger.debug(
            "Request failed, trying " + (tryCount - 1) + " more times",
            { params: logParams, error, requestId },
          );
          return await robustFetch({
            ...params,
            requestId,
            tryCount: tryCount - 1,
            mock,
          });
        } else {
          logger.debug("Request failed", {
            params: logParams,
            error,
            requestId,
          });
          throw new Error("Request failed", {
            cause: {
              params: logParams,
              requestId,
              error,
            },
          });
        }
      } else {
        return null as Output;
      }
    }

    if (ignoreResponse === true) {
      return null as Output;
    }

    let resp: string;
    try {
      resp = await readResponseText(request, maxResponseBytes);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        logger.debug("Sensitive response exceeded byte limit", {
          category: error.category,
          status: error.status,
        });
      }
      throw error;
    }
    response = {
      status: request.status,
      headers: request.headers,
      body: resp, // NOTE: can this throw an exception?
    };
  } else {
    if (ignoreResponse === true) {
      return null as Output;
    }

    const makeRequestTypeId = (
      request: (typeof mock)["requests"][number]["options"],
    ) => {
      let trueUrl = request.url.startsWith(fireEngineURL)
        ? request.url.replace(fireEngineURL, "<fire-engine>")
        : request.url;

      let out = trueUrl + ";" + request.method;
      if (trueUrl.startsWith("<fire-engine>") && request.method === "POST") {
        out += "f-e;" + request.body?.engine + ";" + request.body?.url;
      }
      return out;
    };

    const thisId = makeRequestTypeId(params);
    const matchingMocks = mock.requests
      .filter(x => makeRequestTypeId(x.options) === thisId)
      .sort((a, b) => a.time - b.time);
    const nextI = mock.tracker[thisId] ?? 0;
    mock.tracker[thisId] = nextI + 1;

    if (!matchingMocks[nextI]) {
      throw new Error("Failed to mock request -- no mock targets found.");
    }

    response = {
      ...matchingMocks[nextI].result,
      headers: new Headers(matchingMocks[nextI].result.headers),
    };
    if (
      maxResponseBytes !== undefined &&
      Buffer.byteLength(response.body, "utf8") > maxResponseBytes
    ) {
      throw new ResponseTooLargeError(response.status);
    }
  }

  const responseDiagnostic = sensitiveResponse
    ? { status: response.status }
    : { status: response.status, body: response.body };

  if (response.status >= 300 && !ignoreFailureStatus) {
    const failureDiagnostic = {
      category: "response_status",
      status: response.status,
    };
    if (tryCount > 1) {
      logger.debug(
        "Request sent failure status, trying " + (tryCount - 1) + " more times",
        sensitiveResponse
          ? failureDiagnostic
          : {
              params: logParams,
              response: responseDiagnostic,
              requestId,
            },
      );
      if (tryCooldown !== undefined) {
        let timeoutHandle: NodeJS.Timeout | null = null;
        try {
          await new Promise<null>(resolve => {
            timeoutHandle = setTimeout(() => resolve(null), tryCooldown);
          });
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      }
      return await robustFetch({
        ...params,
        requestId,
        tryCount: tryCount - 1,
        mock,
      });
    } else {
      logger.debug(
        "Request sent failure status",
        sensitiveResponse
          ? failureDiagnostic
          : {
              params: logParams,
              response: responseDiagnostic,
              requestId,
            },
      );
      throw new Error("Request sent failure status", {
        cause: sensitiveResponse
          ? failureDiagnostic
          : {
              params: logParams,
              response: responseDiagnostic,
              requestId,
            },
      });
    }
  }

  if (mock === null && !sensitiveResponse) {
    await saveMock(
      {
        ...params,
        logger: undefined,
        schema: undefined,
        headers: undefined,
      },
      response,
    );
  }

  let data: Output;
  try {
    data = JSON.parse(response.body);
  } catch {
    const malformedDiagnostic = {
      category: "invalid_json",
      status: response.status,
    };
    logger.debug(
      "Request sent malformed JSON",
      sensitiveResponse
        ? malformedDiagnostic
        : {
            params: logParams,
            response: responseDiagnostic,
            requestId,
          },
    );
    throw new Error("Request sent malformed JSON", {
      cause: sensitiveResponse
        ? malformedDiagnostic
        : {
            params: logParams,
            response: responseDiagnostic,
            requestId,
          },
    });
  }

  if (schema) {
    try {
      data = schema.parse(data);
    } catch (error) {
      if (sensitiveResponse) {
        const message =
          error instanceof ZodError
            ? "Response does not match provided schema"
            : "Parsing response with provided schema failed";
        const schemaDiagnostic = {
          category:
            error instanceof ZodError
              ? "invalid_schema"
              : "schema_parse_failed",
          status: response.status,
        };
        logger.debug(message, schemaDiagnostic);
        throw new Error(message, { cause: schemaDiagnostic });
      }
      if (error instanceof ZodError) {
        logger.debug("Response does not match provided schema", {
          params: logParams,
          response: responseDiagnostic,
          requestId,
          error,
          schema,
        });
        throw new Error("Response does not match provided schema", {
          cause: {
            params: logParams,
            response: responseDiagnostic,
            requestId,
            error,
            schema,
          },
        });
      } else {
        logger.debug("Parsing response with provided schema failed", {
          params: logParams,
          response: responseDiagnostic,
          requestId,
          error,
          schema,
        });
        throw new Error("Parsing response with provided schema failed", {
          cause: {
            params: logParams,
            response: responseDiagnostic,
            requestId,
            error,
            schema,
          },
        });
      }
    }
  }

  return data;
}
