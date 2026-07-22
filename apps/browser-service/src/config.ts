import { isAbsolute, join, normalize, resolve } from "node:path";

export type BrowserServiceConfig = {
  port: number;
  apiKey: string;
  stateRoot: string;
  replayRoot: string;
  profilesRoot: string;
  quarantineRoot: string;
  maxBrowserSessions: number;
};

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? String(fallback);
  if (!/^(?:0|[1-9]\d*)$/.test(selected)) {
    throw new TypeError(`${name} must be a canonical decimal integer`);
  }
  const parsed = Number(selected);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function readBrowserServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserServiceConfig {
  const port = parseInteger("PORT", env.PORT, 3010, 1, 65_535);
  const maxBrowserSessions = parseInteger(
    "MAX_BROWSER_SESSIONS",
    env.MAX_BROWSER_SESSIONS,
    8,
    1,
    1_000,
  );

  const apiKey = env.BROWSER_SERVICE_API_KEY;
  if (
    apiKey === undefined ||
    Buffer.byteLength(apiKey, "utf8") < 32 ||
    Buffer.byteLength(`Bearer ${apiKey}`, "utf8") > 4_096
  ) {
    throw new RangeError(
      "BROWSER_SERVICE_API_KEY must be 32..4089 UTF-8 bytes",
    );
  }

  const stateRoot = env.LOCAL_BROWSER_STATE_ROOT;
  if (
    stateRoot === undefined ||
    stateRoot === "/" ||
    !isAbsolute(stateRoot) ||
    normalize(stateRoot) !== stateRoot ||
    resolve(stateRoot) !== stateRoot
  ) {
    throw new TypeError(
      "LOCAL_BROWSER_STATE_ROOT must be a canonical absolute path",
    );
  }

  return {
    port,
    apiKey,
    stateRoot,
    replayRoot: join(stateRoot, "replay"),
    profilesRoot: join(stateRoot, "profiles"),
    quarantineRoot: join(stateRoot, "quarantine"),
    maxBrowserSessions,
  };
}
