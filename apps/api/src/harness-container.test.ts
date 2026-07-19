import { describe, expect, it } from "vitest";

import { containerRemovalCommand } from "./harness-container";

describe("containerRemovalCommand", () => {
  it("preserves container volumes by default", () => {
    expect(containerRemovalCommand("docker", "firecrawl-nuq")).toEqual([
      "docker",
      "rm",
      "-f",
      "firecrawl-nuq",
    ]);
  });

  it("removes owned application database volumes when requested", () => {
    expect(
      containerRemovalCommand(
        "podman",
        "firecrawl-local-persistence-123",
        true,
      ),
    ).toEqual(["podman", "rm", "-f", "-v", "firecrawl-local-persistence-123"]);
  });
});
