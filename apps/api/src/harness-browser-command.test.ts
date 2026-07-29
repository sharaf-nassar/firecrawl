import { describe, expect, it } from "vitest";

import {
  BROWSER_HARNESS_MARKER,
  createHarnessBrowserCommandEnvironment,
  isHarnessControlledBrowserEnvironment,
  localPersistenceHarnessMode,
} from "./harness-browser-command";

const token = Buffer.alloc(32, 7).toString("base64url");

function controlledEnvironment(): NodeJS.ProcessEnv {
  return {
    [BROWSER_HARNESS_MARKER]: token,
    TEST_BROWSER_HARNESS_CONTROL_TOKEN: token,
    TEST_BROWSER_HARNESS_CONTROL_URL: "http://127.0.0.1:39122",
  };
}

describe("localPersistenceHarnessMode", () => {
  it.each([
    ["test:snips:local-persistence", "persistence"],
    ["test:snips:local-browser", "browser"],
  ] as const)("recognizes pnpm %s", (script, mode) => {
    expect(localPersistenceHarnessMode(["pnpm", script])).toBe(mode);
  });

  it("rejects direct vitest and unrelated pnpm commands", () => {
    expect(
      localPersistenceHarnessMode([
        "pnpm",
        "vitest",
        "run",
        "browser-local.test.ts",
      ]),
    ).toBeNull();
    expect(localPersistenceHarnessMode(["pnpm", "test:snips"])).toBeNull();
  });
});

describe("Browser harness environment gating", () => {
  it("creates a child-only marker bound to restart control credentials", () => {
    expect(
      createHarnessBrowserCommandEnvironment("http://127.0.0.1:39122", token),
    ).toEqual(controlledEnvironment());
    expect(() =>
      createHarnessBrowserCommandEnvironment(
        "http://browser-service:3010",
        token,
      ),
    ).toThrow("command environment is invalid");
  });

  it("requires a matching strong marker, control token, and loopback URL", () => {
    expect(isHarnessControlledBrowserEnvironment(controlledEnvironment())).toBe(
      true,
    );

    for (const environment of [
      {},
      {
        ...controlledEnvironment(),
        [BROWSER_HARNESS_MARKER]: Buffer.alloc(32, 8).toString("base64url"),
      },
      {
        ...controlledEnvironment(),
        TEST_BROWSER_HARNESS_CONTROL_TOKEN: "weak",
      },
      {
        ...controlledEnvironment(),
        TEST_BROWSER_HARNESS_CONTROL_URL: "http://browser-service:3010",
      },
      {
        ...controlledEnvironment(),
        TEST_BROWSER_HARNESS_CONTROL_URL: "https://127.0.0.1:39122",
      },
    ]) {
      expect(isHarnessControlledBrowserEnvironment(environment)).toBe(false);
    }
  });
});
