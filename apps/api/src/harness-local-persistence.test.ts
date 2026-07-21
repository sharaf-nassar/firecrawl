import { describe, expect, it, vi } from "vitest";

import {
  clearLocalPersistenceExternalSettings,
  createLocalBrowserStateStartup,
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

describe("createLocalBrowserStateStartup", () => {
  it("health-checks before recovery exactly once", async () => {
    const events: string[] = [];
    const health = vi.fn(async () => {
      events.push("health");
    });
    const recover = vi.fn(async () => {
      events.push("recover");
      return { runsInterrupted: 1 };
    });
    const startup = createLocalBrowserStateStartup({ health, recover });
    const source = {
      enabled: true,
      root: "/var/lib/firecrawl-browser",
    };

    const [first, second] = await Promise.all([
      startup(source),
      startup(source),
    ]);

    expect(events).toEqual(["health", "recover"]);
    expect(health).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledWith("/var/lib/firecrawl-browser");
    expect(recover).toHaveBeenCalledOnce();
    expect(first).toEqual({ runsInterrupted: 1 });
    expect(second).toBe(first);
  });

  it("does no filesystem or recovery work while disabled", async () => {
    const health = vi.fn();
    const recover = vi.fn();
    const startup = createLocalBrowserStateStartup({ health, recover });

    await expect(
      startup({ enabled: false, root: "relative/unusable-root" }),
    ).resolves.toBeUndefined();

    expect(health).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("aborts before recovery when health reports unavailable state", async () => {
    const unavailable = Object.assign(new Error("browser_state_unavailable"), {
      category: "browser_state_unavailable",
    });
    const health = vi.fn().mockRejectedValue(unavailable);
    const recover = vi.fn();
    const startup = createLocalBrowserStateStartup({ health, recover });

    await expect(
      startup({ enabled: true, root: "/var/lib/firecrawl-browser" }),
    ).rejects.toBe(unavailable);
    expect(recover).not.toHaveBeenCalled();
  });
});
