import { describe, expect, it } from "vitest";

import {
  clearLocalPersistenceExternalSettings,
  localPersistenceExternalSettings,
} from "./harness-local-persistence";

describe("clearLocalPersistenceExternalSettings", () => {
  it("removes inherited cloud and browser settings from child environments", () => {
    const env: NodeJS.ProcessEnv = { KEEP_ME: "present" };
    const mutableConfig: Record<string, unknown> = { KEEP_ME: "present" };

    for (const setting of localPersistenceExternalSettings) {
      env[setting] = "inherited";
      mutableConfig[setting] = "inherited";
    }

    clearLocalPersistenceExternalSettings(env, mutableConfig);

    for (const setting of localPersistenceExternalSettings) {
      expect(env).not.toHaveProperty(setting);
      expect(mutableConfig).not.toHaveProperty(setting);
    }
    expect(env.KEEP_ME).toBe("present");
    expect(mutableConfig.KEEP_ME).toBe("present");
  });
});
