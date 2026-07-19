import { describe, expect, it, vi } from "vitest";

import {
  createLocalOwnerAuthenticator,
  isScrapeOwnedBy,
  resolveJobPersistenceOwner,
  resolveScrapePersistenceOwner,
  type AuthenticationWrapper,
} from "./local-owner";
import type { AuthResponse } from "../types";

vi.mock("./keyless", () => ({
  keylessTeamUuid: (teamId: string) =>
    teamId === "preview_keyless_127.0.0.1"
      ? "e50fa284-91f8-5d60-b54a-e0a119a66a06"
      : null,
}));

const localOwnerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";

function authWrapper<TArgs extends any[]>(
  authenticationEnabled: boolean,
): AuthenticationWrapper<TArgs> {
  return (authenticateHosted, mockSuccess) =>
    async (...args) =>
      authenticationEnabled ? authenticateHosted(...args) : mockSuccess;
}

describe("createLocalOwnerAuthenticator", () => {
  it("returns the stable local owner when persistence is enabled", async () => {
    const authenticateHosted = vi.fn();
    const authenticate = createLocalOwnerAuthenticator(
      {
        LOCAL_PERSISTENCE_ENABLED: true,
        APPLICATION_DATABASE_URL:
          "postgresql://firecrawl:password@localhost:5432/firecrawl",
        LOCAL_OWNER_ID: localOwnerId,
        ARTIFACT_STORE_PROVIDER: "none",
        USE_DB_AUTHENTICATION: false,
      },
      authWrapper(false),
      authenticateHosted,
    );

    await expect(authenticate("request", "response")).resolves.toMatchObject({
      success: true,
      team_id: localOwnerId,
      org_id: null,
      chunk: null,
    });
    expect(authenticateHosted).not.toHaveBeenCalled();
  });

  it("keeps the bypass identity in legacy auth-off mode", async () => {
    const authenticateHosted = vi.fn();
    const authenticate = createLocalOwnerAuthenticator(
      {
        LOCAL_PERSISTENCE_ENABLED: false,
        USE_DB_AUTHENTICATION: false,
      },
      authWrapper(false),
      authenticateHosted,
    );

    await expect(authenticate("request", "response")).resolves.toMatchObject({
      success: true,
      team_id: "bypass",
      org_id: null,
      chunk: null,
    });
    expect(authenticateHosted).not.toHaveBeenCalled();
  });

  it("delegates hosted authentication unchanged", async () => {
    const hostedResult: AuthResponse = {
      success: true,
      team_id: "hosted-team",
      org_id: "hosted-org",
      chunk: null,
    };
    const authenticateHosted = vi.fn().mockResolvedValue(hostedResult);
    const authenticate = createLocalOwnerAuthenticator(
      {
        LOCAL_PERSISTENCE_ENABLED: false,
        USE_DB_AUTHENTICATION: true,
      },
      authWrapper(true),
      authenticateHosted,
    );

    await expect(authenticate("request", "response")).resolves.toBe(
      hostedResult,
    );
    expect(authenticateHosted).toHaveBeenCalledWith("request", "response");
  });
});

describe("persistence owner normalization", () => {
  const localSource = {
    LOCAL_PERSISTENCE_ENABLED: true,
    APPLICATION_DATABASE_URL:
      "postgresql://firecrawl:password@localhost:5432/firecrawl",
    LOCAL_OWNER_ID: localOwnerId,
    LOCAL_RECORD_RETENTION_DAYS: 30,
    LOCAL_ARTIFACT_RETENTION_DAYS: 30,
    ARTIFACT_STORE_PROVIDER: "none" as const,
    USE_DB_AUTHENTICATION: false,
  };

  it.each([
    "bypass",
    "preview",
    "preview_keyless_127.0.0.1",
    "f188154d-cbe3-5c40-aa61-fe52d24f8be2",
  ])("uses the stable local owner for %s", teamId => {
    expect(resolveJobPersistenceOwner(teamId, localSource)).toBe(localOwnerId);
    expect(resolveScrapePersistenceOwner(teamId, localSource)).toBe(
      localOwnerId,
    );
  });

  it("preserves legacy preview and raw job mappings", () => {
    const hostedSource = {
      LOCAL_PERSISTENCE_ENABLED: false,
      USE_DB_AUTHENTICATION: true,
    };

    expect(resolveJobPersistenceOwner("preview_abc", hostedSource)).toBe(
      "3adefd26-77ec-5968-8dcf-c94b5630d1de",
    );
    expect(resolveJobPersistenceOwner("hosted-team", hostedSource)).toBe(
      "hosted-team",
    );
  });

  it("preserves deterministic keyless scrape ownership outside local mode", () => {
    const hostedSource = {
      LOCAL_PERSISTENCE_ENABLED: false,
      USE_DB_AUTHENTICATION: true,
    };

    expect(
      resolveScrapePersistenceOwner("preview_keyless_127.0.0.1", hostedSource),
    ).toBe("e50fa284-91f8-5d60-b54a-e0a119a66a06");
  });

  it("accepts the configured local owner and rejects another persisted owner", () => {
    expect(isScrapeOwnedBy(localOwnerId, "bypass", localSource)).toBe(true);
    expect(
      isScrapeOwnedBy(
        "1f971a90-f4d2-4289-b7b7-5ae8b6367fc3",
        "bypass",
        localSource,
      ),
    ).toBe(false);
  });
});
