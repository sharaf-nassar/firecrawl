import { describe, expect, it, vi } from "vitest";

import {
  createLocalOwnerAuthenticator,
  type AuthenticationWrapper,
} from "./local-owner";
import type { AuthResponse } from "../types";

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
