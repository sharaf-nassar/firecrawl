export const BROWSER_HARNESS_MARKER =
  "TEST_BROWSER_HARNESS_INVOCATION_TOKEN" as const;

const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

type LocalPersistenceHarnessMode =
  | "persistence"
  | "browser"
  | "real-codex-browser";

export function localPersistenceHarnessMode(
  command: readonly string[],
): LocalPersistenceHarnessMode | null {
  if (command[0] !== "pnpm") return null;
  if (command[1] === "test:snips:local-persistence") return "persistence";
  if (command[1] === "test:snips:local-browser") return "browser";
  if (command[1] === "test:snips:real-codex-browser")
    return "real-codex-browser";
  return null;
}

export function isHarnessControlledBrowserEnvironment(
  env: NodeJS.ProcessEnv,
): boolean {
  const marker = env[BROWSER_HARNESS_MARKER];
  const controlToken = env.TEST_BROWSER_HARNESS_CONTROL_TOKEN;
  const controlUrl = env.TEST_BROWSER_HARNESS_CONTROL_URL;
  if (
    marker === undefined ||
    controlToken === undefined ||
    marker !== controlToken ||
    !CONTROL_TOKEN.test(controlToken) ||
    controlUrl === undefined
  ) {
    return false;
  }

  try {
    const parsed = new URL(controlUrl);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port !== "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function createHarnessBrowserCommandEnvironment(
  controlUrl: string,
  controlToken: string,
): Readonly<Record<string, string>> {
  const environment = Object.freeze({
    TEST_BROWSER_HARNESS_CONTROL_URL: controlUrl,
    TEST_BROWSER_HARNESS_CONTROL_TOKEN: controlToken,
    [BROWSER_HARNESS_MARKER]: controlToken,
  });
  if (!isHarnessControlledBrowserEnvironment(environment)) {
    throw new Error("Harness Browser command environment is invalid");
  }
  return environment;
}

export function shouldRunRealCodexBrowserSmoke(
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    env.RUN_REAL_CODEX_BROWSER_SMOKE === "1" &&
    isHarnessControlledBrowserEnvironment(env)
  );
}
