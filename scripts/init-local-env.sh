#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"
search_key_helper="${repo_root}/scripts/local-search-key.lib.sh"
if [[ ! -r "${search_key_helper}" ]]; then
  printf 'Required Brave Search key helper is unavailable: %s\n' \
    "${search_key_helper}" >&2
  exit 1
fi
# shellcheck source=scripts/local-search-key.lib.sh
source "${search_key_helper}"

if [[ -e "${env_file}" || -L "${env_file}" ]]; then
  printf 'Refusing to overwrite existing %s\n' "${env_file}" >&2
  exit 1
fi

firecrawl_collect_brave_api_key

postgres_password="$(openssl rand -hex 32)"
app_postgres_password="$(openssl rand -hex 32)"
while [[ "${app_postgres_password}" == "${postgres_password}" ]]; do
  app_postgres_password="$(openssl rand -hex 32)"
done
bull_auth_key="$(openssl rand -hex 32)"
browser_service_api_key="$(
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
)"
browser_replay_ingest_api_key="$(openssl rand -hex 32)"
while [[ "${browser_replay_ingest_api_key}" == "${browser_service_api_key}" ]]; do
  browser_replay_ingest_api_key="$(openssl rand -hex 32)"
done
browser_interaction_worker_token="$(
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
)"
while [[ "${browser_interaction_worker_token}" == "${browser_service_api_key}" ]] ||
  [[ "${browser_interaction_worker_token}" == "${browser_replay_ingest_api_key}" ]]; do
  browser_interaction_worker_token="$(
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
  )"
done
minio_root_password="$(openssl rand -hex 32)"
minio_app_secret_key="$(openssl rand -hex 32)"
while [[ "${minio_app_secret_key}" == "${minio_root_password}" ]]; do
  minio_app_secret_key="$(openssl rand -hex 32)"
done
searxng_secret="$(openssl rand -hex 32)"
while [[ "${searxng_secret}" == "${postgres_password}" ]] ||
  [[ "${searxng_secret}" == "${app_postgres_password}" ]] ||
  [[ "${searxng_secret}" == "${bull_auth_key}" ]] ||
  [[ "${searxng_secret}" == "${browser_service_api_key}" ]] ||
  [[ "${searxng_secret}" == "${browser_replay_ingest_api_key}" ]] ||
  [[ "${searxng_secret}" == "${browser_interaction_worker_token}" ]] ||
  [[ "${searxng_secret}" == "${minio_root_password}" ]] ||
  [[ "${searxng_secret}" == "${minio_app_secret_key}" ]]; do
  searxng_secret="$(openssl rand -hex 32)"
done
local_owner_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"

umask 077
tmp_file="$(mktemp "${env_file}.firecrawl-secret-tmp.init.XXXXXX")"
cleanup() {
  rm -f -- "${tmp_file}"
}
trap cleanup EXIT HUP INT TERM PIPE XFSZ

# @lat: [[operations/local-runtime#Local Runtime Operations#Environment bootstrap]]
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
  printf '%s\n' 'LOCAL_BROWSER_SERVICE_ENABLED=true'
  printf '%s\n' 'LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser-volume/state'
  printf '%s\n' "BROWSER_SERVICE_API_KEY=${browser_service_api_key}"
  printf '%s\n' "BROWSER_REPLAY_INGEST_API_KEY=${browser_replay_ingest_api_key}"
  printf '%s\n' "BROWSER_INTERACTION_WORKER_TOKEN=${browser_interaction_worker_token}"
  printf '%s\n' 'MAX_BROWSER_SESSIONS=4'
  printf '%s\n' "APPLICATION_DATABASE_URL=postgresql://firecrawl:${app_postgres_password}@app-postgres:5432/firecrawl"
  printf '%s\n' "LOCAL_OWNER_ID=${local_owner_id}"
  printf '%s\n' 'LOCAL_RECORD_RETENTION_DAYS=30'
  printf '%s\n' 'LOCAL_ARTIFACT_RETENTION_DAYS=30'
  printf '%s\n' 'MINIO_ROOT_USER=firecrawl-root'
  printf '%s\n' "MINIO_ROOT_PASSWORD=${minio_root_password}"
  printf '%s\n' 'ARTIFACT_STORE_PROVIDER=minio'
  printf '%s\n' 'ARTIFACT_MINIO_ENDPOINT=http://minio:9000'
  printf '%s\n' 'ARTIFACT_MINIO_ACCESS_KEY=firecrawl-app'
  printf '%s\n' "ARTIFACT_MINIO_SECRET_KEY=${minio_app_secret_key}"
  printf '%s\n' 'ARTIFACT_MINIO_BUCKET=firecrawl-artifacts'
  printf '%s\n' 'ARTIFACT_MINIO_REGION=us-east-1'
  printf '%s\n' "BULL_AUTH_KEY=${bull_auth_key}"
  printf '%s\n' 'LOGGING_LEVEL=INFO'
  printf '%s\n' 'ALLOW_LOCAL_WEBHOOKS=false'
  printf '%s\n' 'BLOCK_MEDIA=false'
  printf '%s\n' 'AUTUMN_SECRET_KEY='
  printf '%s\n' 'MODEL_EMBEDDING_NAME='
  printf '%s\n' 'MODEL_NAME=gpt-5.6-luna'
  printf '%s\n' 'NUQ_BACKEND='
  printf '%s\n' 'OLLAMA_BASE_URL='
  printf '%s\n' '# Extract is disabled by default.'
  printf '%s\n' '# 1. Run scripts/local-firecrawl shim-start.'
  printf '%s\n' '# 2. Set OPENAI_BASE_URL and the nonsecret placeholder OPENAI_API_KEY:'
  printf '%s\n' '#    OPENAI_BASE_URL=http://host.docker.internal:3030/v1'
  printf '%s\n' '#    OPENAI_API_KEY=local-codex-shim'
  printf '%s\n' 'OPENAI_API_KEY='
  printf '%s\n' 'OPENAI_BASE_URL='
  printf '%s\n' 'OPENAI_CHAT_COMPLETIONS_ONLY=true'
  printf '%s\n' 'PROXY_PASSWORD='
  printf '%s\n' 'PROXY_SERVER='
  printf '%s\n' 'PROXY_USERNAME='
  printf '%s\n' 'SEARXNG_CATEGORIES='
  printf '%s\n' 'SEARXNG_ENDPOINT=http://searxng:8080'
  printf '%s\n' 'SEARXNG_ENGINES=braveapi,bing'
  printf '%s\n' \
    "SEARXNG_BRAVE_API_KEY_B64=${FIRECRAWL_COLLECTED_BRAVE_API_KEY_B64}"
  printf '%s\n' "SEARXNG_SECRET=${searxng_secret}"
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
