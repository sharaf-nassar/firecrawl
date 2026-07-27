use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::protocol::BundleId;
use crate::redaction::{BrokerError, BrokerResult, ErrorCategory};

const BUNDLES_JSON: &str = include_str!("../../../host/browser-runtime/policy/bundles.json");
const CODEX_SECCOMP_JSON: &str =
    include_str!("../../../host/browser-runtime/policy/codex-seccomp.json");
const CODE_SECCOMP_JSON: &str =
    include_str!("../../../host/browser-runtime/policy/code-seccomp.json");

pub const FIXED_CODEX_CONFIG: &str = r#"model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[history]
persistence = "none"

[analytics]
enabled = false

[features]
apps = false
artifact = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode = false
code_mode_host = false
code_mode_only = false
computer_use = false
enable_mcp_apps = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
memories = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
request_permissions_tool = false
shell_snapshot = false
shell_tool = false
skill_mcp_dependency_install = false
skill_search = false
standalone_web_search = false
tool_call_mcp_elicitation = false
tool_suggest = false
unified_exec = false
workspace_dependencies = false
"#;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPolicy {
    Host,
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResourcePolicy {
    pub network: NetworkPolicy,
    pub cpu_quota: u64,
    pub memory_bytes: u64,
    pub pids: u64,
    pub tmpfs_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleFile {
    version: u32,
    bundles: BTreeMap<String, ResourcePolicy>,
}

#[derive(Clone, Debug)]
pub struct BundlePolicy {
    pub id: BundleId,
    pub resources: ResourcePolicy,
    pub process_args: &'static [&'static str],
    pub process_cwd: &'static str,
    pub environment: &'static [&'static str],
    pub rootfs: PathBuf,
    pub seccomp: Value,
}

impl BundlePolicy {
    pub fn load(id: BundleId) -> BrokerResult<Self> {
        let parsed: BundleFile = crate::protocol::strict_json(BUNDLES_JSON.as_bytes())?;
        if parsed.version != 1 || parsed.bundles.len() != BundleId::ALL.len() {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        let resources = parsed
            .bundles
            .get(id.as_str())
            .cloned()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        for expected in BundleId::ALL {
            if !parsed.bundles.contains_key(expected.as_str()) {
                return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
            }
        }
        validate_resource_policy(id, &resources)?;
        let (process_args, process_cwd, environment, rootfs_name, seccomp_bytes) = match id {
            BundleId::CodexV1 => (
                &[
                    "/opt/firecrawl/bin/codex",
                    "app-server",
                    "--strict-config",
                    "--stdio",
                ][..],
                "/run/firecrawl-work",
                &[
                    "CODEX_HOME=/run/firecrawl-codex",
                    "HOME=/run/firecrawl-home",
                    "PATH=/opt/firecrawl/bin:/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "LC_ALL=C.UTF-8",
                    "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
                ][..],
                "codex-v1",
                CODEX_SECCOMP_JSON,
            ),
            BundleId::CodeNodeV1 => (
                &[
                    "/opt/firecrawl/bin/job-relay-supervisor.mjs",
                    "/opt/firecrawl/bin/run-node.mjs",
                ][..],
                "/run/firecrawl-work",
                &[
                    "HOME=/run/firecrawl-home",
                    "PATH=/opt/firecrawl/bin:/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "LC_ALL=C.UTF-8",
                ][..],
                "code-v1",
                CODE_SECCOMP_JSON,
            ),
            BundleId::CodePythonV1 => (
                &[
                    "/opt/firecrawl/bin/job-relay-supervisor.mjs",
                    "/opt/firecrawl/bin/run-python.py",
                ][..],
                "/run/firecrawl-work",
                &[
                    "HOME=/run/firecrawl-home",
                    "PATH=/opt/firecrawl/bin:/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "LC_ALL=C.UTF-8",
                ][..],
                "code-v1",
                CODE_SECCOMP_JSON,
            ),
            BundleId::CodeBashV1 => (
                &[
                    "/opt/firecrawl/bin/job-relay-supervisor.mjs",
                    "/opt/firecrawl/bin/run-bash.sh",
                ][..],
                "/run/firecrawl-work",
                &[
                    "HOME=/run/firecrawl-home",
                    "PATH=/opt/firecrawl/bin:/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "LC_ALL=C.UTF-8",
                ][..],
                "code-v1",
                CODE_SECCOMP_JSON,
            ),
        };
        let seccomp: Value = crate::protocol::strict_json(seccomp_bytes.as_bytes())?;
        validate_seccomp(&seccomp, id == BundleId::CodexV1)?;
        Ok(Self {
            id,
            resources,
            process_args,
            process_cwd,
            environment,
            rootfs: Path::new("/opt/firecrawl/sandbox-bundles")
                .join(rootfs_name)
                .join("rootfs"),
            seccomp,
        })
    }

    pub const fn descriptor_roles(&self) -> &'static [&'static str] {
        self.id.descriptor_roles()
    }

    pub fn validate_installed_rootfs(&self) -> BrokerResult<()> {
        let identity = self
            .rootfs
            .parent()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?
            .join("rootfs.identity.json");
        validate_rootfs_identity_at(&self.rootfs, &identity, installed_bundle_name(self.id), 0)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RootfsIdentity {
    version: u32,
    bundle_id: String,
    rootfs_sha256: String,
}

pub fn validate_rootfs_identity_at(
    rootfs: &Path,
    identity_path: &Path,
    expected_bundle: &str,
    expected_uid: u32,
) -> BrokerResult<()> {
    let root_directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(rootfs)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let root_metadata = root_directory
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if !root_metadata.file_type().is_dir()
        || root_metadata.uid() != expected_uid
        || root_metadata.mode() & 0o022 != 0
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let mut identity_file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(identity_path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let identity_metadata = identity_file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if !identity_metadata.file_type().is_file()
        || identity_metadata.uid() != expected_uid
        || identity_metadata.mode() & 0o022 != 0
        || identity_metadata.nlink() != 1
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut identity_file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if bytes.len() > 4096 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let identity: RootfsIdentity = crate::protocol::strict_json(&bytes)?;
    if identity.version != 1
        || identity.bundle_id != expected_bundle
        || !valid_sha256(&identity.rootfs_sha256)
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let digest = rootfs_tree_digest(rootfs, expected_uid)?;
    if digest != identity.rootfs_sha256 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(())
}

pub fn rootfs_tree_digest(rootfs: &Path, expected_uid: u32) -> BrokerResult<String> {
    let root_metadata = fs::symlink_metadata(rootfs)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if !root_metadata.file_type().is_dir()
        || root_metadata.uid() != expected_uid
        || root_metadata.mode() & 0o022 != 0
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let mut entries = Vec::new();
    collect_tree_entries(
        rootfs,
        rootfs,
        &mut entries,
        expected_uid,
        root_metadata.dev(),
    )?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (path, record) in entries {
        hasher.update((path.len() as u64).to_be_bytes());
        hasher.update(path.as_bytes());
        hasher.update((record.len() as u64).to_be_bytes());
        hasher.update(record);
    }
    Ok(hex(&hasher.finalize()))
}

fn collect_tree_entries(
    root: &Path,
    directory: &Path,
    output: &mut Vec<(String, Vec<u8>)>,
    expected_uid: u32,
    expected_dev: u64,
) -> BrokerResult<()> {
    let mut children = fs::read_dir(directory)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    children.sort_by_key(fs::DirEntry::file_name);
    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?
            .to_str()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?
            .to_owned();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        if metadata.uid() != expected_uid
            || metadata.dev() != expected_dev
            || (!metadata.file_type().is_symlink() && metadata.mode() & 0o022 != 0)
        {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        if metadata.file_type().is_dir() {
            output.push((
                relative,
                format!("d:{:o}", metadata.mode() & 0o7777).into_bytes(),
            ));
            collect_tree_entries(root, &path, output, expected_uid, expected_dev)?;
        } else if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            let mut record = b"l:".to_vec();
            record.extend_from_slice(target.as_os_str().as_bytes());
            output.push((relative, record));
        } else if metadata.file_type().is_file() {
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
                .open(&path)
                .map_err(|error| {
                    BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
                })?;
            let opened = file.metadata().map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            if opened.dev() != metadata.dev()
                || opened.ino() != metadata.ino()
                || opened.len() != metadata.len()
            {
                return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
            }
            let mut content = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer).map_err(|error| {
                    BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
                })?;
                if count == 0 {
                    break;
                }
                content.update(&buffer[..count]);
            }
            output.push((
                relative,
                format!(
                    "f:{:o}:{}:{}",
                    metadata.mode() & 0o7777,
                    metadata.len(),
                    hex(&content.finalize())
                )
                .into_bytes(),
            ));
        } else {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
    }
    Ok(())
}

const fn installed_bundle_name(id: BundleId) -> &'static str {
    match id {
        BundleId::CodexV1 => "codex-v1",
        BundleId::CodeNodeV1 | BundleId::CodePythonV1 | BundleId::CodeBashV1 => "code-v1",
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn validate_resource_policy(id: BundleId, policy: &ResourcePolicy) -> BrokerResult<()> {
    let expected = match id {
        BundleId::CodexV1 => ResourcePolicy {
            network: NetworkPolicy::Host,
            cpu_quota: 200_000,
            memory_bytes: 2_147_483_648,
            pids: 128,
            tmpfs_bytes: 134_217_728,
        },
        BundleId::CodeNodeV1 | BundleId::CodePythonV1 | BundleId::CodeBashV1 => ResourcePolicy {
            network: NetworkPolicy::None,
            cpu_quota: 100_000,
            memory_bytes: 536_870_912,
            pids: 64,
            tmpfs_bytes: 67_108_864,
        },
    };
    if policy != &expected {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(())
}

fn validate_seccomp(value: &Value, codex: bool) -> BrokerResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
    let expected = [
        "architectures",
        "defaultAction",
        "defaultErrnoRet",
        "syscalls",
    ];
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    if value["defaultAction"] != "SCMP_ACT_ERRNO" || value["defaultErrnoRet"] != 1 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let syscalls = value["syscalls"]
        .as_array()
        .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
    let dangerous = [
        "mount",
        "umount2",
        "unshare",
        "setns",
        "ptrace",
        "bpf",
        "perf_event_open",
        "add_key",
        "request_key",
        "keyctl",
        "init_module",
        "finit_module",
        "delete_module",
        "reboot",
    ];
    for rule in syscalls {
        if rule["action"] != "SCMP_ACT_ALLOW" {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        let names = rule["names"]
            .as_array()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        if names
            .iter()
            .any(|name| dangerous.iter().any(|blocked| name == blocked))
        {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
    }
    if codex
        && !syscalls
            .iter()
            .any(|rule| rule["names"] == serde_json::json!(["socket"]))
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(())
}
