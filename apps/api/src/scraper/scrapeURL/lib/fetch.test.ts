import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "winston";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: mocks.fetch,
}));

vi.mock("./mock", () => ({
  saveMock: mocks.saveMock,
}));

vi.mock("../engines/fire-engine/scrape", () => ({
  fireEngineURL: "https://fire-engine.invalid",
}));

import { Response } from "undici";
import { robustFetch } from "./fetch";

describe("robustFetch sensitive responses", () => {
  const debug = vi.fn();
  const logger = { debug } as unknown as Logger;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function sensitiveFetch(schema: z.ZodTypeAny) {
    return robustFetch({
      url: "https://browser.internal/scrape",
      method: "POST",
      body: { headers: { Authorization: "private-request-secret" } },
      logger,
      schema,
      mock: null,
      sensitiveResponse: true,
      maxResponseBytes: 1_024,
    });
  }

  it("never logs, returns, causes, or saves malformed sensitive bytes", async () => {
    const secret = "private-response-secret";
    mocks.fetch.mockResolvedValue(
      new Response(`{"checkpoint":"${secret}"`, { status: 200 }),
    );

    let failure: unknown;
    try {
      await sensitiveFetch(z.object({ ok: z.boolean() }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const evidence = JSON.stringify({
      logs: debug.mock.calls,
      cause: failure instanceof Error ? failure.cause : failure,
    });
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("private-request-secret");
    expect(debug.mock.calls).toEqual([
      [
        "Request sent malformed JSON",
        { category: "invalid_json", status: 200 },
      ],
    ]);
    expect(failure).toMatchObject({
      cause: { category: "invalid_json", status: 200 },
    });
    expect(mocks.saveMock).not.toHaveBeenCalled();
  });

  it("keeps schema-invalid sensitive bodies out of diagnostics", async () => {
    const secret = "schema-response-secret";
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ checkpoint: secret }), { status: 200 }),
    );

    let failure: unknown;
    try {
      await sensitiveFetch(z.strictObject({ ok: z.boolean() }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    expect(
      JSON.stringify(failure instanceof Error ? failure.cause : failure),
    ).not.toContain(secret);
    expect(debug.mock.calls).toEqual([
      [
        "Response does not match provided schema",
        { category: "invalid_schema", status: 200 },
      ],
    ]);
    expect(failure).toMatchObject({
      cause: { category: "invalid_schema", status: 200 },
    });
    expect(mocks.saveMock).not.toHaveBeenCalled();
  });

  it("rejects sensitive responses before materializing bytes past the cap", async () => {
    const secret = "oversized-response-secret";
    mocks.fetch.mockResolvedValue(
      new Response(secret.repeat(200), { status: 200 }),
    );

    await expect(sensitiveFetch(z.unknown())).rejects.toMatchObject({
      category: "response_too_large",
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    expect(debug.mock.calls).toEqual([
      [
        "Sensitive response exceeded byte limit",
        { category: "response_too_large", status: 200 },
      ],
    ]);
    expect(mocks.saveMock).not.toHaveBeenCalled();
  });

  it("limits sensitive failure-status diagnostics to category and status", async () => {
    const secret = "failure-response-secret";
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ checkpoint: secret }), { status: 502 }),
    );

    let failure: unknown;
    try {
      await sensitiveFetch(z.unknown());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      cause: { category: "response_status", status: 502 },
    });
    expect(debug.mock.calls).toEqual([
      [
        "Request sent failure status",
        { category: "response_status", status: 502 },
      ],
    ]);
    expect(JSON.stringify({ failure, logs: debug.mock.calls })).not.toContain(
      secret,
    );
    expect(mocks.saveMock).not.toHaveBeenCalled();
  });
});
