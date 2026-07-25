import { describe, expect, it } from "vitest";

import { createBrowserProxyUrls } from "./proxy-urls";

describe("browser proxy URLs", () => {
  it("returns only opaque public API URLs with separated permissions", () => {
    const passive = Buffer.alloc(32, 1).toString("base64url");
    const interactive = Buffer.alloc(32, 2).toString("base64url");
    const cdp = Buffer.alloc(32, 3).toString("base64url");
    const urls = createBrowserProxyUrls({
      publicBase: "https://api.example.test",
      publicWsBase: "wss://api.example.test",
      passiveToken: passive,
      interactiveToken: interactive,
      cdpToken: cdp,
    });
    expect(urls).toEqual({
      liveViewUrl: `https://api.example.test/v2/browser/proxy/${passive}/view`,
      interactiveLiveViewUrl: `https://api.example.test/v2/browser/proxy/${interactive}/view`,
      cdpUrl: `wss://api.example.test/v2/browser/proxy/${cdp}/cdp`,
    });
    expect(JSON.stringify(urls)).not.toContain("browser-service");
  });

  it("rejects credentials, paths, and malformed tokens", () => {
    expect(() =>
      createBrowserProxyUrls({
        publicBase: "https://user@example.test",
        publicWsBase: "wss://api.example.test",
        passiveToken: "a".repeat(43),
        interactiveToken: "b".repeat(43),
        cdpToken: "c".repeat(43),
      }),
    ).toThrow();
    expect(() =>
      createBrowserProxyUrls({
        publicBase: "https://api.example.test/base",
        publicWsBase: "wss://api.example.test",
        passiveToken: "raw/token",
        interactiveToken: "b".repeat(43),
        cdpToken: "c".repeat(43),
      }),
    ).toThrow();
  });
});
