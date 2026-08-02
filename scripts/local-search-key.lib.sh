#!/usr/bin/env bash

firecrawl_validate_brave_api_key() {
  local api_key="$1"

  if [[ -z "$api_key" ]]; then
    return 1
  fi
  if [[ "$api_key" =~ [[:space:]] ]]; then
    return 1
  fi
  return 0
}

firecrawl_encode_brave_api_key() {
  local api_key="$1"

  printf '%s' "$api_key" | base64 | tr -d '\n'
}

firecrawl_validate_brave_api_key_b64() {
  local encoded="$1"
  local canonical
  local decoded

  if [[ -z "$encoded" ]]; then
    return 1
  fi
  if ! decoded="$(printf '%s' "$encoded" | base64 --decode 2>/dev/null)"; then
    return 1
  fi
  canonical="$(firecrawl_encode_brave_api_key "$decoded")"
  if [[ -z "$decoded" || "$canonical" != "$encoded" ]] ||
    [[ "$decoded" =~ [[:space:]] ]]; then
    return 1
  fi
  return 0
}

firecrawl_collect_brave_api_key() {
  local api_key=""

  if [[ -v FIRECRAWL_SEARXNG_BRAVE_API_KEY ]]; then
    api_key="$FIRECRAWL_SEARXNG_BRAVE_API_KEY"
  elif [[ -t 0 && -t 2 ]]; then
    printf '%s' \
      'Brave Search API key (required; input hidden): ' >&2
    if ! IFS= read -r -s api_key; then
      printf '\nUnable to read Brave Search API key\n' >&2
      return 1
    fi
    printf '\n' >&2
  fi
  unset FIRECRAWL_SEARXNG_BRAVE_API_KEY

  if [[ -z "$api_key" ]]; then
    printf '%s\n' \
      'Brave Search API key is required for bundled search.' \
      'Set FIRECRAWL_SEARXNG_BRAVE_API_KEY for noninteractive setup or run scripts/local-firecrawl configure-search.' >&2
    return 1
  fi

  if ! firecrawl_validate_brave_api_key "$api_key"; then
    printf '%s\n' \
      'Brave Search API key has an invalid format' >&2
    return 1
  fi

  FIRECRAWL_COLLECTED_BRAVE_API_KEY_B64="$(
    firecrawl_encode_brave_api_key "$api_key"
  )"
  api_key=""

}
