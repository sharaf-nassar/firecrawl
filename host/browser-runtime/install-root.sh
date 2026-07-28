#!/usr/bin/env bash

set -Eeuo pipefail

readonly BROKER_CONTRACT_SHA256='587c8e3da5f7050ec1a9ac2fd26a349b9fef7e82ddfd424f74a61172968700e4'
readonly MIN_SYSTEMD_VERSION=254
readonly SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_ROOT="${FIRECRAWL_HOST_TEST_ROOT:-}"
readonly TEST_GROUP_ACTIVATION="${FIRECRAWL_HOST_TEST_GROUP_ACTIVATION:-}"
readonly TEST_DIRECTORY_UID="${FIRECRAWL_HOST_TEST_DIRECTORY_UID:-}"

staging=
adapter_user=
adapter_uid=
group_was_present=0
adapter_was_member=0
group_state_known=0
membership_state_known=0
broker_socket_was_enabled=0
linger_was_enabled=0
runtime_root_was_present=0

fail() {
  printf 'firecrawl_host_install_failed: %s\n' "$1" >&2
  return 1
}

usage() {
  printf '%s\n' \
    'Usage: install-root.sh --staging <absolute-path> --adapter-user <name> --adapter-uid <uid>' >&2
}

while (( $# > 0 )); do
  case "$1" in
    --staging)
      (( $# >= 2 )) || { usage; exit 64; }
      staging="$2"
      shift 2
      ;;
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

[[ -n "$staging" && -n "$adapter_user" && -n "$adapter_uid" ]] || {
  usage
  exit 64
}
[[ "$adapter_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
  fail 'adapter_user_invalid'
[[ "$adapter_uid" =~ ^[1-9][0-9]{0,9}$ ]] ||
  fail 'adapter_uid_invalid'
(( adapter_uid <= 4294967294 )) || fail 'adapter_uid_invalid'

if [[ -n "$TEST_ROOT" ]]; then
  [[ "$TEST_ROOT" == /* && "$TEST_ROOT" != / ]] ||
    fail 'test_root_invalid'
  canonical_test_root="$(readlink -f -- "$TEST_ROOT")"
  [[ "$canonical_test_root" == "$TEST_ROOT" ]] || fail 'test_root_invalid'
  readonly ROOT="$TEST_ROOT"
  readonly FAKE_INSTALL=1
else
  (( EUID == 0 )) || fail 'root_required'
  readonly ROOT=
  readonly FAKE_INSTALL=0
fi
if [[ -n "$TEST_GROUP_ACTIVATION" ]]; then
  (( FAKE_INSTALL == 1 )) || fail 'test_group_activation_requires_fake_root'
  [[ "$TEST_GROUP_ACTIVATION" == active ||
    "$TEST_GROUP_ACTIVATION" == stale ]] ||
    fail 'test_group_activation_invalid'
fi
if [[ -n "$TEST_DIRECTORY_UID" ]]; then
  (( FAKE_INSTALL == 1 )) || fail 'test_directory_uid_requires_fake_root'
  [[ "$TEST_DIRECTORY_UID" =~ ^[1-9][0-9]{0,9}$ ]] ||
    fail 'test_directory_uid_invalid'
fi
if (( FAKE_INSTALL == 1 )); then
  expected_directory_uid="${TEST_DIRECTORY_UID:-$adapter_uid}"
  expected_directory_gid="$(stat -c %g -- "$ROOT")"
  root_owner_uid="$adapter_uid"
  root_mode=700
else
  expected_directory_uid=0
  expected_directory_gid=0
  root_owner_uid=0
  root_mode=755
fi

directory_identity() {
  local path=$1
  local uid=$2
  local gid=$3
  local mode=$4
  [[ -d "$path" && ! -L "$path" &&
    "$(stat -c '%u:%g:%a' -- "$path")" == "$uid:$gid:$mode" ]]
}

directory_identity "${ROOT:-/}" \
  "$root_owner_uid" "$expected_directory_gid" "$root_mode" ||
  fail 'install_root_identity'

root_path() {
  printf '%s%s\n' "$ROOT" "$1"
}

user_systemctl() {
  runuser -u "$adapter_user" -- env \
    "XDG_RUNTIME_DIR=/run/user/$adapter_uid" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$adapter_uid/bus" \
    systemctl --user "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_command_$1"
}

for command in \
  chmod cmp cp cut find flock getent grep install jq ln mv readlink \
  sed sha256sum stat
do
  require_command "$command"
done

[[ "$staging" == /* ]] || fail 'staging_not_absolute'
canonical_staging="$(readlink -f -- "$staging")"
[[ "$canonical_staging" == "$staging" && -d "$staging" ]] ||
  fail 'staging_not_canonical'
[[ ! -L "$staging" ]] || fail 'staging_symlink'

if find "$staging" -xdev -type l \
  ! -path "$staging/bundles/codex-v1/rootfs/*" \
  ! -path "$staging/bundles/code-v1/rootfs/*" \
  -print -quit | grep -q .; then
  fail 'staging_symlink'
fi
if find "$staging" -xdev ! -type l -perm /022 -print -quit | grep -q .; then
  fail 'staging_writable'
fi
if find "$staging" -xdev ! -uid "$adapter_uid" -print -quit | grep -q .; then
  fail 'staging_owner'
fi

required_staging=(
  SHA256SUMS
  manifest.json
  codex-app-server.tar
  codex-app-server.manifest.json
  gate-attestation.json
  bin/firecrawl-sandbox-broker
  bin/firecrawl-browser-execution-adapter
  bin/acceptance-restart-broker
  bundles/codex-v1/rootfs
  bundles/codex-v1/rootfs.identity.json
  bundles/code-v1/rootfs
  bundles/code-v1/rootfs.identity.json
  policy/bundles.json
  policy/code-seccomp.json
  policy/codex-seccomp.json
  protocol/sandbox-broker-v1.contract.json
  protocol/codex-app-server
  protocol/codex-app-server.manifest.json
)
for relative in "${required_staging[@]}"; do
  [[ -e "$staging/$relative" ]] || fail "staging_missing_$relative"
done

verify_checksum_inventory() {
  local root="$1"
  local manifest="$2"
  local previous=
  local digest relative extra

  [[ -f "$manifest" && ! -L "$manifest" ]] ||
    fail 'checksum_manifest_invalid'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9._/@-]+)$ ]] ||
      fail 'checksum_manifest_invalid'
    digest="${BASH_REMATCH[1]}"
    relative="${BASH_REMATCH[2]}"
    [[ "$relative" != SHA256SUMS &&
      "$relative" != /* &&
      "$relative" != *'..'* &&
      "$relative" != *'//'*
    ]] || fail 'checksum_manifest_invalid'
    [[ -z "$previous" || "$previous" < "$relative" ]] ||
      fail 'checksum_manifest_invalid'
    previous="$relative"
    [[ -f "$root/$relative" && ! -L "$root/$relative" ]] ||
      fail 'checksum_entry_invalid'
    [[ "$(sha256sum -- "$root/$relative")" == "$digest  $root/$relative" ]] ||
      fail 'checksum_mismatch'
  done < "$manifest"
}

verify_checksum_inventory "$staging" "$staging/SHA256SUMS"
verify_checksum_inventory \
  "$staging/protocol/codex-app-server" \
  "$staging/protocol/codex-app-server/SHA256SUMS"

jq -e '
  type == "object" and
  keys == [
    "binaryHashes", "brokerContractSha256", "buildTimestamp",
    "bundleDigests", "codeRuntime", "codexAppServer", "formatVersion",
    "policyHashes"
  ] and
  .formatVersion == 1 and
  .brokerContractSha256 == $contract and
  (.binaryHashes | keys) == [
    "acceptance-restart-broker",
    "firecrawl-browser-execution-adapter",
    "firecrawl-sandbox-broker"
  ] and
  (.bundleDigests | keys) == ["code-v1", "codex-v1"] and
  (.policyHashes | keys) == [
    "bundles.json", "code-seccomp.json", "codex-seccomp.json"
  ] and
  .codexAppServer.formatVersion == 1 and
  .codexAppServer.model == "gpt-5.6-terra" and
  .codexAppServer.reasoningEffort == "medium" and
  .codexAppServer.sourceIdentity.executablePath[0:1] == "/" and
  .codexAppServer.sourceIdentity.resolvedPath[0:1] == "/" and
  (.codexAppServer.sourceIdentity.device | test("^(0|[1-9][0-9]*)$")) and
  (.codexAppServer.sourceIdentity.inode | test("^(0|[1-9][0-9]*)$")) and
  (.codexAppServer.sourceIdentity.version |
    test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.-]+)?$"))
' --arg contract "$BROKER_CONTRACT_SHA256" "$staging/manifest.json" >/dev/null ||
  fail 'manifest_identity'

manifest_digest="$(sha256sum -- "$staging/manifest.json")"
manifest_digest="${manifest_digest%% *}"
generation_name="host-$manifest_digest"
[[ ! "$generation_name" =~ [0-9]+\.[0-9]+\.[0-9]+ ]] ||
  fail 'versioned_generation'

verify_bound_digest() {
  local manifest_query="$1"
  local path="$2"
  local expected actual
  expected="$(jq -er "$manifest_query" "$staging/manifest.json")" ||
    fail 'manifest_digest_missing'
  actual="$(sha256sum -- "$staging/$path")"
  actual="${actual%% *}"
  [[ "$actual" == "$expected" ]] || fail "manifest_digest_mismatch_$path"
}

verify_bound_digest '.binaryHashes["firecrawl-sandbox-broker"]' \
  bin/firecrawl-sandbox-broker
verify_bound_digest '.binaryHashes["firecrawl-browser-execution-adapter"]' \
  bin/firecrawl-browser-execution-adapter
verify_bound_digest '.binaryHashes["acceptance-restart-broker"]' \
  bin/acceptance-restart-broker
verify_bound_digest '.policyHashes["bundles.json"]' policy/bundles.json
verify_bound_digest '.policyHashes["code-seccomp.json"]' policy/code-seccomp.json
verify_bound_digest '.policyHashes["codex-seccomp.json"]' policy/codex-seccomp.json
verify_bound_digest '.codexAppServer.artifactSha256' codex-app-server.tar

contract_digest="$(sha256sum -- "$staging/protocol/sandbox-broker-v1.contract.json")"
contract_digest="${contract_digest%% *}"
[[ "$contract_digest" == "$BROKER_CONTRACT_SHA256" ]] ||
  fail 'broker_contract_mismatch'
cmp -s \
  "$staging/codex-app-server.manifest.json" \
  "$staging/protocol/codex-app-server.manifest.json" ||
  fail 'codex_manifest_mismatch'
jq -e --slurpfile top "$staging/manifest.json" \
  '. == $top[0].codexAppServer' \
  "$staging/codex-app-server.manifest.json" >/dev/null ||
  fail 'codex_manifest_identity'

lock_path="$(root_path /run/firecrawl-host-install.lock)"
lock_parent="$(dirname -- "$lock_path")"
if [[ ! -e "$lock_parent" && ! -L "$lock_parent" ]]; then
  (( FAKE_INSTALL == 1 )) || fail 'runtime_directory_missing'
  install -d -m 0755 "$lock_parent"
fi
directory_identity "$lock_parent" \
  "$root_owner_uid" "$expected_directory_gid" 755 ||
  fail 'runtime_directory_identity'
exec {install_lock_fd}> "$lock_path"
flock --exclusive "$install_lock_fd"

remove_group_prerequisite() {
  if (( FAKE_INSTALL == 1 )); then
    if [[ -n "$TEST_GROUP_ACTIVATION" &&
      "$group_state_known" == 1 && "$membership_state_known" == 1 ]]
    then
      rm -f -- \
        "$(root_path /run/firecrawl-host-test-group/membership)" \
        "$(root_path /run/firecrawl-host-test-group/group)"
      rmdir "$(root_path /run/firecrawl-host-test-group)" 2>/dev/null || true
    fi
  else
    if (( membership_state_known == 1 && adapter_was_member == 0 )); then
      /usr/bin/gpasswd -d "$adapter_user" firecrawl-sandbox >/dev/null 2>&1 || true
    fi
    if (( group_state_known == 1 && group_was_present == 0 )); then
      /usr/sbin/groupdel firecrawl-sandbox >/dev/null 2>&1 || true
    fi
  fi
}

install_root="$(root_path /opt/firecrawl)"
generations="$install_root/generations"
generation="$generations/$generation_name"
temporary_generation="$generations/.new-$generation_name-$$"
transaction_root="$(root_path /run/firecrawl-host-install-$$)"
backup_root="$transaction_root/backup"
created_generation=0
mutation_started=0
created_directories=()
stable_link_temps=()
targets=(
  /etc/systemd/system/firecrawl-sandbox-broker.socket
  /etc/systemd/system/firecrawl-sandbox-broker.service
  /etc/systemd/user/firecrawl-execution-adapter.service
  /usr/lib/tmpfiles.d/firecrawl-sandbox.conf
  /etc/sudoers.d/firecrawl-browser-host
  /usr/share/polkit-1/actions/org.firecrawl.browser-host.policy
  /etc/firecrawl/browser-host.env
  /usr/local/libexec/firecrawl-sandbox-broker
  /usr/local/libexec/firecrawl-browser-execution-adapter
  /usr/local/libexec/firecrawl-acceptance-restart-broker
  /opt/firecrawl/current
  /opt/firecrawl/protocol
  /opt/firecrawl/policy
  /opt/firecrawl/sandbox-bundles
)
declare -A target_existed=()

rollback() {
  local status=$?
  trap - ERR
  if (( FAKE_INSTALL == 1 )); then
    for removable in "$temporary_generation"; do
      if [[ -d "$removable" ]]; then
        find "$removable" -type d -exec chmod u+rwx {} + 2>/dev/null || true
      fi
    done
    if (( created_generation == 1 )) && [[ -d "$generation" ]]; then
      find "$generation" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    fi
  fi
  rm -rf -- "$temporary_generation"
  rm -f -- "$(root_path /usr/local/libexec/firecrawl-sandbox-broker.new)" \
    "$(root_path /usr/local/libexec/firecrawl-browser-execution-adapter.new)" \
    "$(root_path /usr/local/libexec/firecrawl-acceptance-restart-broker.new)" \
    "$install_root/.current-$$"
  if (( ${#stable_link_temps[@]} > 0 )); then
    rm -f -- "${stable_link_temps[@]}"
  fi
  if (( mutation_started == 1 )); then
    for target in "${targets[@]}"; do
      installed_target="$(root_path "$target")"
      rm -rf -- "$installed_target"
      if [[ "${target_existed[$target]}" == 1 ]]; then
        install -d -m 0755 "$(dirname -- "$installed_target")"
        cp -a -- "$backup_root$target" "$installed_target"
      fi
    done
    if (( FAKE_INSTALL == 0 )); then
      systemctl daemon-reload >/dev/null 2>&1 || true
      if (( broker_socket_was_enabled == 1 )); then
        systemctl enable firecrawl-sandbox-broker.socket >/dev/null 2>&1 || true
      else
        systemctl disable firecrawl-sandbox-broker.socket >/dev/null 2>&1 || true
      fi
      if (( linger_was_enabled == 0 )); then
        loginctl disable-linger "$adapter_user" >/dev/null 2>&1 || true
      fi
      if (( runtime_root_was_present == 0 )); then
        rmdir /run/firecrawl-sandbox >/dev/null 2>&1 || true
      fi
    fi
  fi
  remove_group_prerequisite
  if (( created_generation == 1 )); then
    rm -rf -- "$generation"
  fi
  rm -rf -- "$transaction_root"
  for (( index=${#created_directories[@]} - 1; index >= 0; index-- )); do
    rmdir "${created_directories[$index]}" 2>/dev/null || true
  done
  exit "$status"
}
trap rollback ERR

ensure_install_directory() {
  local path=$1
  local mode=$2
  local mode_identity=${mode#0}
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || fail 'install_directory_invalid'
  else
    install -d -m "$mode" "$path"
    created_directories+=("$path")
  fi
  directory_identity "$path" \
    "$expected_directory_uid" "$expected_directory_gid" "$mode_identity" ||
    fail 'install_directory_identity'
}

if (( FAKE_INSTALL == 0 )); then
  systemd_version="$(systemd --version | sed -n '1s/^systemd \\([0-9][0-9]*\\).*/\\1/p')"
  [[ "$systemd_version" =~ ^[0-9]+$ ]] || fail 'systemd_version_unknown'
  systemd-analyze compare-versions "$systemd_version" ge "$MIN_SYSTEMD_VERSION" ||
    fail 'systemd_too_old'
  current_uid="$(getent passwd "$adapter_user" | cut -d: -f3)"
  [[ "$current_uid" == "$adapter_uid" ]] || fail 'adapter_identity_mismatch'
  if getent group firecrawl-sandbox >/dev/null; then
    group_was_present=1
    group_state_known=1
  else
    /usr/sbin/groupadd --system firecrawl-sandbox
    group_state_known=1
  fi
  if id -nG "$adapter_user" | tr ' ' '\n' | grep -Fxq firecrawl-sandbox; then
    adapter_was_member=1
    membership_state_known=1
  else
    /usr/sbin/usermod -a -G firecrawl-sandbox "$adapter_user"
    membership_state_known=1
  fi
  sandbox_gid="$(getent group firecrawl-sandbox | cut -d: -f3)"
  [[ "$sandbox_gid" =~ ^[1-9][0-9]*$ ]] || fail 'sandbox_group_invalid'
  user_manager_pid="$(
    systemctl show "user@$adapter_uid.service" \
      --property=MainPID --value 2>/dev/null || true
  )"
  if [[ "$user_manager_pid" =~ ^[1-9][0-9]*$ ]] &&
    ! sed -n 's/^Groups:[[:space:]]*//p' \
      "/proc/$user_manager_pid/status" |
      tr ' ' '\n' |
      grep -Fxq "$sandbox_gid"
  then
    trap - ERR
    printf 'firecrawl_adapter_group_refresh_required: log out and back in or restart user@%s.service, then rerun install-host\n' \
      "$adapter_uid" >&2
    exit 75
  fi
elif [[ -n "$TEST_GROUP_ACTIVATION" ]]; then
  ensure_install_directory "$(root_path /run/firecrawl-host-test-group)" 0700
  install -m 0600 /dev/null "$(root_path /run/firecrawl-host-test-group/group)"
  group_state_known=1
  install -m 0600 /dev/null \
    "$(root_path /run/firecrawl-host-test-group/membership)"
  membership_state_known=1
  if [[ "$TEST_GROUP_ACTIVATION" == stale ]]; then
    trap - ERR
    printf 'firecrawl_adapter_group_refresh_required: simulated stale user manager\n' >&2
    exit 75
  fi
fi

for directory in \
  /opt /usr /usr/local /etc /etc/systemd /usr/lib /usr/share \
  /usr/share/polkit-1
do
  ensure_install_directory "$(root_path "$directory")" 0755
done
for directory in \
  /opt/firecrawl /opt/firecrawl/generations /usr/local/libexec \
  /etc/firecrawl /etc/systemd/system /etc/systemd/user \
  /usr/lib/tmpfiles.d /etc/sudoers.d /usr/share/polkit-1/actions
do
  ensure_install_directory "$(root_path "$directory")" 0755
done
if (( FAKE_INSTALL == 1 )) &&
  [[ "${FIRECRAWL_HOST_TEST_FAIL_AT:-}" == after-install-directories ]]
then
  false
fi

rm -rf -- "$temporary_generation"
install -d -m 0700 "$backup_root"
for target in "${targets[@]}"; do
  installed_target="$(root_path "$target")"
  if [[ -e "$installed_target" || -L "$installed_target" ]]; then
    target_existed["$target"]=1
    install -d -m 0700 "$backup_root$(dirname -- "$target")"
    cp -a -- "$installed_target" "$backup_root$target"
  else
    target_existed["$target"]=0
  fi
done

if [[ ! -d "$generation" ]]; then
  install -d -m 0755 "$temporary_generation"
  if (( FAKE_INSTALL == 1 )) &&
    [[ "${FIRECRAWL_HOST_TEST_FAIL_AT:-}" == before-generation-copy ]]
  then
    false
  fi
  cp -a -- "$staging/." "$temporary_generation/"
  if (( FAKE_INSTALL == 0 )); then
    chown -R root:root "$temporary_generation"
  fi
  chmod 0755 "$temporary_generation"
  find "$temporary_generation/protocol" -type d -exec chmod 0555 {} +
  find "$temporary_generation/protocol" -type f -exec chmod 0444 {} +
  chmod 0555 "$temporary_generation/bin"
  chmod 0555 "$temporary_generation/bin/"*
  expected_generation_uid="$adapter_uid"
  if (( FAKE_INSTALL == 0 )); then
    expected_generation_uid=0
  fi
  /usr/bin/python3 "$SCRIPT_ROOT/verify-generation.py" \
    "$temporary_generation" "$expected_generation_uid"
  mv -T -- "$temporary_generation" "$generation"
  created_generation=1
else
  [[ -f "$generation/manifest.json" ]] || fail 'generation_collision'
  existing_digest="$(sha256sum -- "$generation/manifest.json")"
  existing_digest="${existing_digest%% *}"
  [[ "$existing_digest" == "$manifest_digest" ]] ||
    fail 'generation_collision'
  expected_generation_uid="$adapter_uid"
  if (( FAKE_INSTALL == 0 )); then
    expected_generation_uid=0
  fi
  /usr/bin/python3 "$SCRIPT_ROOT/verify-generation.py" \
    "$generation" "$expected_generation_uid"
fi

mutation_started=1
if (( FAKE_INSTALL == 0 )); then
  if systemctl is-enabled --quiet firecrawl-sandbox-broker.socket; then
    broker_socket_was_enabled=1
  fi
  if [[ -e "/var/lib/systemd/linger/$adapter_user" ]]; then
    linger_was_enabled=1
  fi
  if [[ -d /run/firecrawl-sandbox ]]; then
    runtime_root_was_present=1
  fi
fi

install -m 0644 \
  "$SCRIPT_ROOT/systemd/firecrawl-sandbox-broker.socket" \
  "$(root_path /etc/systemd/system/firecrawl-sandbox-broker.socket)"
install -m 0644 \
  "$SCRIPT_ROOT/systemd/firecrawl-sandbox-broker.service" \
  "$(root_path /etc/systemd/system/firecrawl-sandbox-broker.service)"
install -m 0644 \
  "$SCRIPT_ROOT/systemd/firecrawl-execution-adapter.service" \
  "$(root_path /etc/systemd/user/firecrawl-execution-adapter.service)"
install -m 0644 \
  "$SCRIPT_ROOT/tmpfiles/firecrawl-sandbox.conf" \
  "$(root_path /usr/lib/tmpfiles.d/firecrawl-sandbox.conf)"
install -m 0440 \
  "$SCRIPT_ROOT/sudoers/firecrawl-browser-host" \
  "$(root_path /etc/sudoers.d/firecrawl-browser-host)"
install -m 0644 \
  "$SCRIPT_ROOT/polkit/org.firecrawl.browser-host.policy" \
  "$(root_path /usr/share/polkit-1/actions/org.firecrawl.browser-host.policy)"
printf 'FIRECRAWL_ADAPTER_UID=%s\n' "$adapter_uid" \
  > "$(root_path /etc/firecrawl/browser-host.env)"
chmod 0644 "$(root_path /etc/firecrawl/browser-host.env)"

launcher_names=(
  firecrawl-sandbox-broker
  firecrawl-browser-execution-adapter
  firecrawl-acceptance-restart-broker
)
for name in "${launcher_names[@]}"; do
  install -m 0755 \
    "$SCRIPT_ROOT/libexec/$name" \
    "$(root_path /usr/local/libexec/$name.new)"
done

for name in "${launcher_names[@]}"; do
  mv -Tf -- \
    "$(root_path /usr/local/libexec/$name.new)" \
    "$(root_path /usr/local/libexec/$name)"
done

publish_stable_link() {
  local name=$1
  local target=$2
  local destination="$install_root/$name"
  local temporary="$install_root/.$name.new-$$"
  stable_link_temps+=("$temporary")
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$destination"
  [[ -L "$destination" &&
    "$(readlink -- "$destination")" == "$target" &&
    "$(stat -c '%u:%g' -- "$destination")" == "$expected_directory_uid:$expected_directory_gid" ]] ||
    fail 'stable_link_identity'
}

publish_stable_link protocol current/protocol
publish_stable_link policy current/policy
publish_stable_link sandbox-bundles current/bundles
publish_stable_link current "generations/$generation_name"
if (( FAKE_INSTALL == 1 )) &&
  [[ "${FIRECRAWL_HOST_TEST_FAIL_AT:-}" == after-pointer ]]
then
  false
fi

if (( FAKE_INSTALL == 0 )); then
  /usr/sbin/visudo -cf "$(root_path /etc/sudoers.d/firecrawl-browser-host)" >/dev/null
  python3 -c \
    'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' \
    "$(root_path /usr/share/polkit-1/actions/org.firecrawl.browser-host.policy)"
  systemd-analyze verify \
    "$(root_path /etc/systemd/system/firecrawl-sandbox-broker.socket)" \
    "$(root_path /etc/systemd/system/firecrawl-sandbox-broker.service)" \
    "$(root_path /etc/systemd/user/firecrawl-execution-adapter.service)"
  systemd-tmpfiles --create "$(root_path /usr/lib/tmpfiles.d/firecrawl-sandbox.conf)"
  systemctl daemon-reload
  systemctl enable firecrawl-sandbox-broker.socket
  loginctl enable-linger "$adapter_user"
  user_systemctl daemon-reload
  user_systemctl enable firecrawl-execution-adapter.service
fi

trap - ERR
rm -rf -- "$transaction_root"
printf 'Installed Firecrawl browser host generation %s\n' "$generation_name"
