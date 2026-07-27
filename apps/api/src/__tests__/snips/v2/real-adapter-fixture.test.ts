import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { RealAdapterFixture } from "./real-adapter-fixture";

const token = Buffer.alloc(32, 9).toString("base64url");

describe("RealAdapterFixture", () => {
  it.each([
    "https://127.0.0.1:39122",
    "http://localhost:39122",
    "http://adapter.example:39122",
    "http://127.0.0.1:39122/path",
    "http://user@127.0.0.1:39122",
  ])("rejects unsafe adapter URL %s", baseUrl => {
    expect(() => new RealAdapterFixture(baseUrl, token)).toThrow(
      "exact loopback HTTP",
    );
  });

  it("rejects a weak adapter bearer token", () => {
    expect(
      () => new RealAdapterFixture("http://127.0.0.1:39122", "weak"),
    ).toThrow("32-byte base64url");
  });

  it("uses redirect-error fetch and validates the scenario handle", async () => {
    const scenarioId = randomUUID();
    const marker = randomUUID();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ scenarioId, marker }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const fixture = new RealAdapterFixture(
      "http://127.0.0.1:39122",
      token,
      fetchImpl,
    );

    await expect(fixture.begin("prompt_contract")).resolves.toEqual({
      scenarioId,
      marker,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:39122/v1/scenarios"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: `Bearer ${token}`,
        }),
      }),
    );
  });

  it("rejects a redirected response even from a noncompliant fetch", async () => {
    const fixture = new RealAdapterFixture(
      "http://127.0.0.1:39122",
      token,
      vi.fn(async () => ({ redirected: true }) as Response),
    );

    await expect(fixture.begin("prompt_contract")).rejects.toThrow(
      "redirected",
    );
  });

  it.each([
    { scenarioId: "not-a-uuid", marker: randomUUID() },
    { scenarioId: randomUUID(), marker: "unbounded marker text" },
    { scenarioId: randomUUID(), marker: randomUUID(), extra: true },
  ])("rejects unsafe scenario handles", async body => {
    const fixture = new RealAdapterFixture(
      "http://127.0.0.1:39122",
      token,
      vi.fn(async () => new Response(JSON.stringify(body))),
    );

    await expect(fixture.begin("prompt_contract")).rejects.toThrow(
      /invalid (scenarioId|marker|scenario handle)/,
    );
  });

  it("rejects a declared oversized response before reading its body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      cancel,
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
    });
    const response = new Response(body, {
      headers: { "content-length": String(1024 * 1024 + 1) },
    });
    const declared = new RealAdapterFixture(
      "http://127.0.0.1:39122",
      token,
      vi.fn(async () => response),
    );

    await expect(declared.begin("prompt_contract")).rejects.toThrow(
      "response is too large",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response as soon as its streamed bytes exceed the limit", async () => {
    const cancel = vi.fn();
    let pullCount = 0;
    const body = new ReadableStream({
      cancel,
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(600 * 1024));
      },
    });
    const response = new Response(body);
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const actual = new RealAdapterFixture(
      "http://127.0.0.1:39122",
      token,
      vi.fn(async () => response),
    );

    await expect(actual.begin("prompt_contract")).rejects.toThrow(
      "response is too large",
    );
    expect(pullCount).toBeGreaterThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
