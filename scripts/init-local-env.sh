#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"

if [[ -e "${env_file}" ]]; then
  printf 'Refusing to overwrite existing %s\n' "${env_file}" >&2
  exit 1
fi

postgres_password="$(openssl rand -hex 32)"
bull_auth_key="$(openssl rand -hex 32)"

umask 077
{
  printf '%s\n' 'PORT=3002'
  printf '%s\n' 'INTERNAL_PORT=3002'
  printf '%s\n' 'USE_DB_AUTHENTICATION=false'
  printf '%s\n' 'POSTGRES_USER=firecrawl'
  printf '%s\n' "POSTGRES_PASSWORD=${postgres_password}"
  printf '%s\n' 'POSTGRES_DB=postgres'
  printf '%s\n' "BULL_AUTH_KEY=${bull_auth_key}"
  printf '%s\n' 'LOGGING_LEVEL=INFO'
  printf '%s\n' 'ALLOW_LOCAL_WEBHOOKS=false'
  printf '%s\n' 'BLOCK_MEDIA=false'
} > "${env_file}"

printf 'Created %s with mode 0600 credentials.\n' "${env_file}"
