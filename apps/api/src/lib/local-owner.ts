import type { AuthResponse } from "../types";
import {
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "./local-runtime-config";

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
