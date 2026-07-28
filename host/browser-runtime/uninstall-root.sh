#!/usr/bin/env bash

set -Eeuo pipefail

readonly TEST_ROOT="${FIRECRAWL_HOST_TEST_ROOT:-}"
adapter_user=
adapter_uid=

fail() {
  printf 'firecrawl_host_uninstall_failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'Usage: uninstall-root.sh --adapter-user <name> --adapter-uid <uid>' >&2
}

while (( $# > 0 )); do
  case "$1" in
    --adapter-user)
      (( $# >= 2 )) || { usage; exit 64; }
      adapter_user="$2"
      shift 2
      ;;
    --adapter-uid)
      (( $# >= 2 )) || { usage; exit 64; }
      adapter_uid="$2"
      shift 2
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

[[ "$adapter_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
  fail 'adapter_user_invalid'
[[ "$adapter_uid" =~ ^[1-9][0-9]{0,9}$ ]] ||
  fail 'adapter_uid_invalid'

if [[ -n "$TEST_ROOT" ]]; then
  [[ "$TEST_ROOT" == /* && "$TEST_ROOT" != / &&
    "$(readlink -f -- "$TEST_ROOT")" == "$TEST_ROOT"
  ]] || fail 'test_root_invalid'
  readonly ROOT="$TEST_ROOT"
  readonly FAKE_INSTALL=1
else
  (( EUID == 0 )) || fail 'root_required'
  readonly ROOT=
  readonly FAKE_INSTALL=0
  [[ "$(getent passwd "$adapter_user" | cut -d: -f3)" == "$adapter_uid" ]] ||
    fail 'adapter_identity_mismatch'
fi

root_path() {
  printf '%s%s\n' "$ROOT" "$1"
}

lock_path="$(root_path /run/firecrawl-host-install.lock)"
install -d -m 0755 "$(dirname -- "$lock_path")"
exec {install_lock_fd}> "$lock_path"
flock --exclusive "$install_lock_fd"

user_systemctl() {
  runuser -u "$adapter_user" -- env \
    "XDG_RUNTIME_DIR=/run/user/$adapter_uid" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$adapter_uid/bus" \
    systemctl --user "$@"
}

adapter_was_active=0
if (( FAKE_INSTALL == 0 )); then
  if user_systemctl is-active --quiet firecrawl-execution-adapter.service; then
    adapter_was_active=1
    user_systemctl stop firecrawl-execution-adapter.service ||
      fail 'adapter_stop_failed'
  fi
fi

active_jobs() {
  local runtime_jobs
  local cgroup_jobs
  runtime_jobs="$(root_path /run/firecrawl-sandbox/jobs)"
  cgroup_jobs="$(root_path /sys/fs/cgroup/system.slice/firecrawl-sandbox-broker.service/jobs)"
  if [[ -d "$runtime_jobs" ]] &&
    find "$runtime_jobs" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
  then
    return 0
  fi
  if [[ -d "$cgroup_jobs" ]] &&
    find "$cgroup_jobs" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .
  then
    return 0
  fi
  return 1
}

if active_jobs; then
  if (( FAKE_INSTALL == 0 && adapter_was_active == 1 )); then
    user_systemctl start firecrawl-execution-adapter.service ||
      fail 'active_jobs_adapter_restore_failed'
  fi
  fail 'active_jobs'
fi

if (( FAKE_INSTALL == 0 )); then
  if systemctl is-active --quiet firecrawl-sandbox-broker.socket; then
    systemctl stop firecrawl-sandbox-broker.socket ||
      fail 'broker_socket_stop_failed'
  fi
  if systemctl is-active --quiet firecrawl-sandbox-broker.service; then
    systemctl stop firecrawl-sandbox-broker.service ||
      fail 'broker_stop_failed'
  fi
fi

active_jobs && fail 'active_jobs_after_stop'

if (( FAKE_INSTALL == 0 )); then
  user_systemctl disable firecrawl-execution-adapter.service ||
    fail 'adapter_disable_failed'
  systemctl disable firecrawl-sandbox-broker.socket ||
    fail 'broker_socket_disable_failed'
  systemd-tmpfiles --remove \
    "$(root_path /usr/lib/tmpfiles.d/firecrawl-sandbox.conf)" ||
    fail 'tmpfiles_remove_failed'
fi

rm -f -- \
  "$(root_path /etc/systemd/system/firecrawl-sandbox-broker.socket)" \
  "$(root_path /etc/systemd/system/firecrawl-sandbox-broker.service)" \
  "$(root_path /etc/systemd/user/firecrawl-execution-adapter.service)" \
  "$(root_path /usr/lib/tmpfiles.d/firecrawl-sandbox.conf)" \
  "$(root_path /etc/sudoers.d/firecrawl-browser-host)" \
  "$(root_path /usr/share/polkit-1/actions/org.firecrawl.browser-host.policy)" \
  "$(root_path /etc/firecrawl/browser-host.env)" \
  "$(root_path /usr/local/libexec/firecrawl-sandbox-broker)" \
  "$(root_path /usr/local/libexec/firecrawl-browser-execution-adapter)" \
  "$(root_path /usr/local/libexec/firecrawl-acceptance-restart-broker)"
if (( FAKE_INSTALL == 1 )) && [[ -d "$(root_path /opt/firecrawl)" ]]; then
  find "$(root_path /opt/firecrawl)" -type d -exec chmod u+rwx {} +
fi
rm -rf -- "$(root_path /opt/firecrawl)"

if (( FAKE_INSTALL == 0 )); then
  systemctl daemon-reload
  user_systemctl daemon-reload
fi

printf '%s\n' 'Uninstalled Firecrawl browser host services and generations'
