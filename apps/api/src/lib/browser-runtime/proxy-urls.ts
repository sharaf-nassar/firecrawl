import { tokenSchema } from "../scrape-interact/browser-service-contracts";

type BrowserProxyUrlInput = {
  publicBase: string;
  publicWsBase: string;
  passiveToken: string;
  interactiveToken: string;
  cdpToken: string;
};

function exactOrigin(value: string, protocols: readonly string[]): string {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Browser proxy base must be an exact public origin");
  }
  return url.origin;
}

/** @public Builds opaque API-owned URLs without exposing private service data. */
export function createBrowserProxyUrls(input: BrowserProxyUrlInput): {
  liveViewUrl: string;
  interactiveLiveViewUrl: string;
  cdpUrl: string;
} {
  const publicBase = exactOrigin(input.publicBase, ["http:", "https:"]);
  const publicWsBase = exactOrigin(input.publicWsBase, ["ws:", "wss:"]);
  const passiveToken = tokenSchema.parse(input.passiveToken);
  const interactiveToken = tokenSchema.parse(input.interactiveToken);
  const cdpToken = tokenSchema.parse(input.cdpToken);
  return {
    liveViewUrl: `${publicBase}/v2/browser/proxy/${passiveToken}/view`,
    interactiveLiveViewUrl: `${publicBase}/v2/browser/proxy/${interactiveToken}/view`,
    cdpUrl: `${publicWsBase}/v2/browser/proxy/${cdpToken}/cdp`,
  };
}
