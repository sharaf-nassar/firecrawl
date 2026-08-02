import { MAX_LOG_METADATA_BYTES, serializeLogMetadata } from "./logger";

describe("bounded logger metadata", () => {
  // @lat: [[api/tests#API Test Organization#Unit and component tests#Bounded logger metadata]]
  it("keeps useful error identity without provider bodies", () => {
    const marker = "provider-response-body-marker";
    const cause = Object.assign(new Error("provider unavailable"), {
      responseBody: marker.repeat(10_000),
    });
    const error = Object.assign(new Error("request failed", { cause }), {
      code: "E_UPSTREAM",
      requestBodyValues: { prompt: marker.repeat(10_000) },
    });

    const parsed = JSON.parse(serializeLogMetadata({ error }));

    expect(parsed.error).toMatchObject({
      name: "Error",
      message: "request failed",
      code: "E_UPSTREAM",
      cause: { name: "Error", message: "provider unavailable" },
    });
    expect(parsed.error.stack).toContain("Error: request failed");
    expect(JSON.stringify(parsed)).not.toContain(marker);
  });

  it("bounds huge nested and cyclic records", () => {
    const hostile = "\0".repeat(10_000);
    const cause = Object.assign(new Error(hostile), {
      name: hostile,
      code: hostile,
    });
    cause.cause = cause;
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    Object.assign(
      metadata,
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`field${index}`, index]),
      ),
      {
        module: "logger-test",
        method: "serialize",
        jobId: "job-1",
        error: Object.assign(new Error(hostile, { cause }), {
          name: hostile,
          stack: hostile,
          code: hostile,
          reason: hostile,
          engine: hostile,
        }),
        data: Array.from({ length: 100 }, () => "x".repeat(10_000)),
      },
    );

    const serialized = serializeLogMetadata(metadata);
    const parsed = JSON.parse(serialized);

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      MAX_LOG_METADATA_BYTES,
    );
    expect(parsed).toMatchObject({
      module: "logger-test",
      method: "serialize",
      jobId: "job-1",
      error: {
        cause: {
          cause: "[Circular]",
        },
      },
    });
    expect(parsed.error.name).toContain("[truncated]");
    expect(parsed.error.message).toContain("[truncated]");
    expect(parsed.error.stack).toContain("[truncated]");
    expect(parsed).not.toHaveProperty("data");
    expect(parsed).not.toHaveProperty("field0");
  });
});
