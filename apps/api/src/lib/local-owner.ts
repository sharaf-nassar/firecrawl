import type { AuthResponse } from "../types";
import { config } from "../config";
import {
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "./local-runtime-config";
import { keylessTeamUuid } from "./keyless";

const previewTeamId = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

function resolveLocalPersistenceOwner(
  source: LocalRuntimeConfigSource,
): string | null {
  if (source.LOCAL_PERSISTENCE_ENABLED !== true) return null;
  const localConfig = resolveLocalRuntimeConfig(source);
  return localConfig.enabled ? localConfig.ownerId : null;
}

export function resolveJobPersistenceOwner(
  teamId: string,
  source: LocalRuntimeConfigSource = config,
): string {
  return (
    resolveLocalPersistenceOwner(source) ??
    (teamId === "preview" || teamId.startsWith("preview_")
      ? previewTeamId
      : teamId)
  );
}

export function resolveScrapePersistenceOwner(
  teamId: string,
  source: LocalRuntimeConfigSource = config,
): string {
  return (
    resolveLocalPersistenceOwner(source) ??
    keylessTeamUuid(teamId) ??
    resolveJobPersistenceOwner(teamId, source)
  );
}

function resolveScrapeOwnershipOwner(
  teamId: string,
  source: LocalRuntimeConfigSource = config,
): string {
  return (
    resolveLocalPersistenceOwner(source) ?? keylessTeamUuid(teamId) ?? teamId
  );
}

export function isScrapeOwnedBy(
  persistedTeamId: string,
  requestTeamId: string,
  source: LocalRuntimeConfigSource = config,
): boolean {
  return persistedTeamId === resolveScrapeOwnershipOwner(requestTeamId, source);
}

export type AuthenticationWrapper<TArgs extends any[]> = (
  authenticateHosted: (...args: TArgs) => Promise<AuthResponse>,
  mockSuccess: AuthResponse,
) => (...args: TArgs) => Promise<AuthResponse>;

export function createLocalOwnerAuthenticator<TArgs extends any[]>(
  source: LocalRuntimeConfigSource,
  wrapAuthentication: AuthenticationWrapper<TArgs>,
  authenticateHosted: (...args: TArgs) => Promise<AuthResponse>,
): (...args: TArgs) => Promise<AuthResponse> {
  const localConfig = resolveLocalRuntimeConfig(source);

  return wrapAuthentication(authenticateHosted, {
    success: true,
    chunk: null,
    team_id: localConfig.enabled ? localConfig.ownerId : "bypass",
    org_id: null,
  });
}
