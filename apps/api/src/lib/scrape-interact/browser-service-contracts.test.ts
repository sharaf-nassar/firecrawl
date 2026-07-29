import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  apiPrivateV1Fingerprint,
  apiPrivateV1Inventory,
  BROWSER_SERVICE_ERROR_STATUS,
  buildApiPrivateV1Inventory,
  canonicalJson,
  canonicalUuidSchema,
  httpUrlSchema,
  privateErrorV1Schema,
  type PrivateV1Inventory,
} from "./browser-service-contracts";

const fixturePath = path.resolve(
  process.cwd(),
  "../browser-service/contracts/private-v1.contract.json",
);

describe("API-owned Browser Service V1 contracts", () => {
  it("includes session-policy error statuses", () => {
    expect(BROWSER_SERVICE_ERROR_STATUS).toMatchObject({
      replay_unavailable: 409,
      replay_unsupported: 409,
      concurrency_exceeded: 429,
      session_not_found: 404,
    });
  });

  it("matches the canonical V1 inventory without service imports", async () => {
    const source = await readFile(
      path.resolve(
        process.cwd(),
        "src/lib/scrape-interact/browser-service-contracts.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/browser-service\/src/);

    const fixture = JSON.parse(
      canonicalJson(
        JSON.parse(await readFile(fixturePath, "utf8")) as PrivateV1Inventory,
      ),
    ) as PrivateV1Inventory;
    const canonicalFixtureBytes = canonicalJson(fixture);

    expect(apiPrivateV1Inventory).toEqual(fixture);
    expect(apiPrivateV1Fingerprint).toBe(
      createHash("sha256").update(canonicalFixtureBytes).digest("hex"),
    );
  });

  it("detects API schema, route, status, header, and cap drift", async () => {
    const fixture = JSON.parse(
      canonicalJson(
        JSON.parse(await readFile(fixturePath, "utf8")) as PrivateV1Inventory,
      ),
    ) as PrivateV1Inventory;
    const mutatedRoute = fixture.routes.map((route, index) =>
      index === 0 ? { ...route, method: "GET" as const } : route,
    );
    const mutations = [
      buildApiPrivateV1Inventory({
        schemaOverrides: {
          SessionV1: z.strictObject({
            version: z.literal(1),
            reviewMutation: z.literal(true),
          }),
        },
      }),
      buildApiPrivateV1Inventory({ routes: mutatedRoute }),
      buildApiPrivateV1Inventory({
        statusByCategory: {
          ...fixture.definitions.errors.statusByCategory,
          control_generation_mismatch: 418,
        },
      }),
      buildApiPrivateV1Inventory({
        authHeaders: {
          ...fixture.definitions.headers.auth,
          deadline: "x-review-mutated-deadline",
        },
      }),
      buildApiPrivateV1Inventory({
        constantOverrides: { maxArtifactBytes: 1 },
      }),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toEqual(fixture);
      expect(
        createHash("sha256").update(canonicalJson(mutation)).digest("hex"),
      ).not.toBe(apiPrivateV1Fingerprint);
    }
  });

  it("preserves raw union keywords, shared refs, and ref siblings", () => {
    const rawSchema = {
      $defs: {
        named: {
          anyOf: [{ type: "string" }, { maxLength: 8, type: "string" }],
        },
      },
      oneOf: [
        { $ref: "#/$defs/named", description: "reference sibling" },
        { anyOf: [{ const: "a" }, { const: "b" }] },
      ],
    };

    expect(JSON.parse(canonicalJson(rawSchema))).toEqual(rawSchema);
    expect(canonicalJson(rawSchema)).toContain('"oneOf"');
    expect(canonicalJson(rawSchema)).toContain('"anyOf"');
    expect(canonicalJson(rawSchema)).toContain('"$ref"');
    expect(canonicalJson(rawSchema)).toContain('"description"');
  });

  it("rejects uppercase UUIDs and every non-HTTP URL at API parity boundary", () => {
    const validId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
    expect(canonicalUuidSchema.safeParse(validId).success).toBe(true);
    expect(canonicalUuidSchema.safeParse(validId.toUpperCase()).success).toBe(
      false,
    );
    for (const url of [
      "file:///etc/passwd",
      "mailto:a@example.test",
      "ftp://example.test/a",
      "https://user:pass@example.test/",
    ]) {
      expect(httpUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it("keeps private error envelopes strict and bounded", () => {
    expect(
      privateErrorV1Schema.safeParse({
        version: 1,
        category: "invalid_request",
        message: "invalid",
      }).success,
    ).toBe(true);
    expect(
      privateErrorV1Schema.safeParse({
        version: 1,
        category: "invalid_request",
        message: "invalid",
        privateUrl: "http://browser-service:3010",
      }).success,
    ).toBe(false);
    expect(
      privateErrorV1Schema.safeParse({
        version: 1,
        category: "invalid_request",
        message: "x".repeat(1_025),
      }).success,
    ).toBe(false);
  });
});
