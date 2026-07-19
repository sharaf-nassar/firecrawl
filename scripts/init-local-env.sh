#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"

if [[ -e "${env_file}" || -L "${env_file}" ]]; then
  printf 'Refusing to overwrite existing %s\n' "${env_file}" >&2
  exit 1
fi

postgres_password="$(openssl rand -hex 32)"
app_postgres_password="$(openssl rand -hex 32)"
while [[ "${app_postgres_password}" == "${postgres_password}" ]]; do
  app_postgres_password="$(openssl rand -hex 32)"
done
bull_auth_key="$(openssl rand -hex 32)"
local_owner_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"

umask 077
tmp_file="$(mktemp "${env_file}.firecrawl-secret-tmp.init.XXXXXX")"
cleanup() {
  rm -f -- "${tmp_file}"
}
trap cleanup EXIT HUP INT TERM PIPE XFSZ

{
  printf '%s\n' 'COMPOSE_FILE=compose.yaml'
  printf '%s\n' 'PORT=3002'
  printf '%s\n' 'INTERNAL_PORT=3002'
  printf '%s\n' 'USE_DB_AUTHENTICATION=false'
  printf '%s\n' 'POSTGRES_USER=firecrawl'
  printf '%s\n' "POSTGRES_PASSWORD=${postgres_password}"
  printf '%s\n' 'POSTGRES_DB=postgres'
  printf '%s\n' 'APP_POSTGRES_USER=firecrawl'
  printf '%s\n' "APP_POSTGRES_PASSWORD=${app_postgres_password}"
  printf '%s\n' 'APP_POSTGRES_DB=firecrawl'
  printf '%s\n' 'LOCAL_PERSISTENCE_ENABLED=true'
  printf '%s\n' "APPLICATION_DATABASE_URL=postgresql://firecrawl:${app_postgres_password}@app-postgres:5432/firecrawl"
  printf '%s\n' "LOCAL_OWNER_ID=${local_owner_id}"
  printf '%s\n' 'LOCAL_RECORD_RETENTION_DAYS=30'
  printf '%s\n' 'LOCAL_ARTIFACT_RETENTION_DAYS=30'
  printf '%s\n' "BULL_AUTH_KEY=${bull_auth_key}"
  printf '%s\n' 'LOGGING_LEVEL=INFO'
  printf '%s\n' 'ALLOW_LOCAL_WEBHOOKS=false'
  printf '%s\n' 'BLOCK_MEDIA=false'
  printf '%s\n' 'AUTUMN_SECRET_KEY='
  printf '%s\n' 'MODEL_EMBEDDING_NAME='
  printf '%s\n' 'MODEL_NAME='
  printf '%s\n' 'NUQ_BACKEND='
  printf '%s\n' 'OLLAMA_BASE_URL='
  printf '%s\n' 'OPENAI_API_KEY='
  printf '%s\n' 'OPENAI_BASE_URL='
  printf '%s\n' 'PROXY_PASSWORD='
  printf '%s\n' 'PROXY_SERVER='
  printf '%s\n' 'PROXY_USERNAME='
  printf '%s\n' 'SEARXNG_CATEGORIES='
  printf '%s\n' 'SEARXNG_ENDPOINT='
  printf '%s\n' 'SEARXNG_ENGINES='
  printf '%s\n' 'SELF_HOSTED_WEBHOOK_URL='
  printf '%s\n' 'SLACK_WEBHOOK_URL='
  printf '%s\n' 'SUPABASE_ANON_TOKEN='
  printf '%s\n' 'SUPABASE_SERVICE_TOKEN='
  printf '%s\n' 'SUPABASE_URL='
  printf '%s\n' 'TEST_API_KEY='
} > "${tmp_file}"

chmod 0600 "${tmp_file}"
if ! ln -- "${tmp_file}" "${env_file}"; then
  printf 'Refusing to overwrite existing %s\n' "${env_file}" >&2
  exit 1
fi
rm -f -- "${tmp_file}"
trap - EXIT HUP INT TERM PIPE XFSZ

printf 'Created %s with mode 0600 credentials.\n' "${env_file}"
