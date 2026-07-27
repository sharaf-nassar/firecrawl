use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use nix::fcntl::{FcntlArg, SealFlag, fcntl};
use nix::sys::memfd::{MFdFlags, memfd_create};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::bundles::{BundlePolicy, NetworkPolicy};
use crate::peer::{ValidatedDescriptors, read_bounded};
use crate::protocol::{BundleId, RuncState};
use crate::redaction::{BrokerError, BrokerResult, ErrorCategory};

const OPENAT2_RESOLVE_NO_SYMLINKS: u64 = 0x04;
const OPENAT2_RESOLVE_BENEATH: u64 = 0x08;
const MAX_ARTIFACT_COUNT: usize = 8;
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const ARTIFACT_TMPFS_BYTES: u64 = MAX_ARTIFACT_TOTAL_BYTES;
const PRODUCTION_RUNTIME_ROOT: &str = "/run/firecrawl-sandbox";
pub const PRODUCTION_SERVICE_CGROUP_PATH: &str = "/system.slice/firecrawl-sandbox-broker.service";
pub const PRODUCTION_BROKER_CGROUP_PATH: &str =
    "/system.slice/firecrawl-sandbox-broker.service/broker";
pub const PRODUCTION_CGROUPS_PATH: &str = "/system.slice/firecrawl-sandbox-broker.service/jobs";

#[derive(Debug)]
pub struct JobLayout {
    pub job_id: Uuid,
    pub bundle_id: BundleId,
    pub rootfs: PathBuf,
    pub directory: PathBuf,
    pub pid_file: PathBuf,
    pub pidfd_socket: PathBuf,
    pub config_file: PathBuf,
    pub attestation_file: PathBuf,
    pub artifact_directory: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RuncStateRecord {
    #[serde(rename = "ociVersion")]
    pub oci_version: String,
    pub id: String,
    pub pid: i64,
    pub status: RuncState,
    pub bundle: String,
    pub rootfs: String,
    pub created: String,
    pub annotations: std::collections::BTreeMap<String, String>,
    pub owner: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedAttestation {
    version: u32,
    correlation_id: Uuid,
    job_id: Uuid,
    phase: AttestationPhase,
    init_pid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AttestationPhase {
    Prepared,
}

#[derive(Debug)]
pub struct SealedArtifact {
    pub record: crate::protocol::ArtifactRecord,
    pub descriptor: OwnedFd,
}

pub fn create_job_layout(
    runtime_root: &Path,
    job_id: Uuid,
    policy: &BundlePolicy,
    descriptors: &ValidatedDescriptors,
) -> BrokerResult<JobLayout> {
    validate_runtime_root(runtime_root)?;
    let jobs = runtime_root.join("jobs");
    create_or_validate_directory(&jobs, 0o700)?;
    let directory = jobs.join(job_id.to_string());
    fs::create_dir(&directory)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;

    let mut mounted_artifact = None;
    let result = (|| {
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        validate_secure_directory(&directory)?;
        let artifact_directory = if policy.id == BundleId::CodexV1 {
            None
        } else {
            let path = directory.join("artifacts");
            fs::create_dir(&path).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            if nix::unistd::geteuid().is_root() {
                nix::unistd::chown(
                    &path,
                    Some(nix::unistd::Uid::from_raw(65_532)),
                    Some(nix::unistd::Gid::from_raw(65_532)),
                )
                .map_err(|error| {
                    BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
                })?;
            }
            if runtime_root == Path::new(PRODUCTION_RUNTIME_ROOT) {
                mount_artifact_tmpfs(&path)?;
                mounted_artifact = Some(path.clone());
            }
            Some(path)
        };
        if policy.id == BundleId::CodexV1 {
            let auth = descriptors
                .descriptor("auth")
                .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
            let config = descriptors
                .descriptor("config")
                .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
            materialize(&directory, "auth.json", auth, 1024 * 1024)?;
            materialize(&directory, "config.toml", config, 64 * 1024)?;
        }
        let config_file = directory.join("config.json");
        let config = generate_oci_config(job_id, policy, &directory)?;
        let mut file = secure_create(&directory, "config.json", 0o600)?;
        serde_json::to_writer(&mut file, &config)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        file.write_all(b"\n")
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        file.sync_all()
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        sync_directory(&directory)?;
        Ok(JobLayout {
            job_id,
            bundle_id: policy.id,
            rootfs: policy.rootfs.clone(),
            pid_file: directory.join("pid"),
            pidfd_socket: directory.join("pidfd.sock"),
            attestation_file: directory.join("acceptance.json"),
            artifact_directory,
            directory: directory.clone(),
            config_file,
        })
    })();
    if result.is_err() {
        let unmounted = mounted_artifact
            .as_deref()
            .is_none_or(|path| unmount_artifact_tmpfs(path).is_ok());
        let removed = fs::remove_dir_all(&directory).is_ok();
        if !unmounted || !removed {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
    }
    result
}

pub fn generate_oci_config(
    job_id: Uuid,
    policy: &BundlePolicy,
    job_directory: &Path,
) -> BrokerResult<Value> {
    const CODE_HOME_TMPFS_BYTES: u64 = 8 * 1024 * 1024;
    const CODE_JOB_TMPFS_BYTES: u64 = 8 * 1024 * 1024;
    const CODEX_HOME_TMPFS_BYTES: u64 = 16 * 1024 * 1024;
    let home_tmpfs_bytes = if policy.id == BundleId::CodexV1 {
        CODEX_HOME_TMPFS_BYTES
    } else {
        CODE_HOME_TMPFS_BYTES
    };
    let job_tmpfs_bytes = if policy.id == BundleId::CodexV1 {
        0
    } else {
        CODE_JOB_TMPFS_BYTES
    };
    let artifact_tmpfs_bytes = if policy.id == BundleId::CodexV1 {
        0
    } else {
        ARTIFACT_TMPFS_BYTES
    };
    let work_tmpfs_bytes = policy
        .resources
        .tmpfs_bytes
        .checked_sub(home_tmpfs_bytes + job_tmpfs_bytes + artifact_tmpfs_bytes)
        .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
    let mut namespaces = vec![
        json!({"type":"pid"}),
        json!({"type":"ipc"}),
        json!({"type":"uts"}),
        json!({"type":"mount"}),
    ];
    if policy.resources.network == NetworkPolicy::None {
        namespaces.push(json!({"type":"network"}));
    }
    let mut mounts = vec![
        json!({
            "destination":"/proc",
            "type":"proc",
            "source":"proc",
            "options":["nosuid","noexec","nodev"]
        }),
        json!({
            "destination":"/sys",
            "type":"sysfs",
            "source":"sysfs",
            "options":["nosuid","noexec","nodev","ro"]
        }),
        json!({
            "destination":"/run/firecrawl-work",
            "type":"tmpfs",
            "source":"tmpfs",
            "options":[
                "nosuid",
                "noexec",
                "nodev",
                "mode=0700",
                "uid=65532",
                "gid=65532",
                format!("size={work_tmpfs_bytes}")
            ]
        }),
        json!({
            "destination":"/run/firecrawl-home",
            "type":"tmpfs",
            "source":"tmpfs",
            "options":["nosuid","noexec","nodev","mode=0700","uid=65532","gid=65532",format!("size={home_tmpfs_bytes}")]
        }),
    ];
    if policy.id == BundleId::CodexV1 {
        mounts.extend([
            json!({
                "destination":"/run/firecrawl-codex/auth.json",
                "type":"bind",
                "source":job_directory.join("auth.json"),
                "options":["bind","ro","nosuid","noexec","nodev"]
            }),
            json!({
                "destination":"/run/firecrawl-codex/config.toml",
                "type":"bind",
                "source":job_directory.join("config.toml"),
                "options":["bind","ro","nosuid","noexec","nodev"]
            }),
        ]);
    } else {
        mounts.push(json!({
            "destination":"/run/firecrawl-job",
            "type":"tmpfs",
            "source":"tmpfs",
            "options":["nosuid","noexec","nodev","mode=0700","uid=65532","gid=65532",format!("size={CODE_JOB_TMPFS_BYTES}")]
        }));
        mounts.push(json!({
            "destination":"/run/firecrawl-job/artifacts",
            "type":"bind",
            "source":job_directory.join("artifacts"),
            "options":["bind","rw","nosuid","noexec","nodev"]
        }));
    }
    let config = json!({
        "ociVersion":"1.2.0",
        "root":{
            "path":policy.rootfs,
            "readonly":true
        },
        "process":{
            "terminal":false,
            "user":{"uid":65532,"gid":65532},
            "args":policy.process_args,
            "env":policy.environment,
            "cwd":policy.process_cwd,
            "capabilities":{
                "bounding":[],
                "effective":[],
                "inheritable":[],
                "permitted":[],
                "ambient":[]
            },
            "rlimits":[
                {"type":"RLIMIT_NOFILE","hard":1024,"soft":1024},
                {"type":"RLIMIT_CORE","hard":0,"soft":0}
            ],
            "noNewPrivileges":true
        },
        "hostname":"firecrawl-sandbox",
        "mounts":mounts,
        "linux":{
            "namespaces":namespaces,
            "maskedPaths":[
                "/proc/acpi",
                "/proc/asound",
                "/proc/kcore",
                "/proc/keys",
                "/proc/latency_stats",
                "/proc/timer_list",
                "/proc/timer_stats",
                "/proc/sched_debug",
                "/sys/firmware",
                "/sys/devices/virtual/powercap"
            ],
            "readonlyPaths":[
                "/proc/bus",
                "/proc/fs",
                "/proc/irq",
                "/proc/sys",
                "/proc/sysrq-trigger"
            ],
            "resources":{
                "cpu":{"period":100000,"quota":policy.resources.cpu_quota},
                "memory":{
                    "limit":policy.resources.memory_bytes,
                    "swap":policy.resources.memory_bytes
                },
                "pids":{"limit":policy.resources.pids}
            },
            "cgroupsPath":format!("{PRODUCTION_CGROUPS_PATH}/firecrawl-{job_id}"),
            "seccomp":policy.seccomp
        },
        "annotations":{
            "com.firecrawl.bundle":policy.id.as_str(),
            "com.firecrawl.job":job_id.to_string()
        }
    });
    if config.get("hooks").is_some() {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(config)
}

pub fn parse_pid_file(bytes: &[u8]) -> BrokerResult<u32> {
    let digits = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if digits.is_empty()
        || digits.len() > 10
        || digits.iter().any(|byte| !byte.is_ascii_digit())
        || (digits.len() > 1 && digits[0] == b'0')
        || bytes
            .strip_suffix(b"\n")
            .is_some_and(|_| bytes.ends_with(b"\n\n"))
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let text = std::str::from_utf8(digits)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let pid = text
        .parse::<u32>()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(pid)
}

pub fn parse_runc_state(
    bytes: &[u8],
    expected_job_id: Uuid,
    expected_bundle: &Path,
    expected_rootfs: &Path,
    expected_bundle_id: BundleId,
) -> BrokerResult<RuncStateRecord> {
    let state: RuncStateRecord = crate::protocol::strict_json(bytes)?;
    let expected = expected_bundle
        .canonicalize()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let actual_path = Path::new(&state.bundle);
    let actual_link = fs::symlink_metadata(actual_path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if actual_link.file_type().is_symlink() {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let actual = actual_path
        .canonicalize()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let expected_rootfs = expected_rootfs
        .canonicalize()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let actual_rootfs_path = Path::new(&state.rootfs);
    let actual_rootfs_link = fs::symlink_metadata(actual_rootfs_path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if actual_rootfs_link.file_type().is_symlink() {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let actual_rootfs = actual_rootfs_path
        .canonicalize()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let expected_metadata = fs::metadata(&expected)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let actual_metadata = fs::metadata(&actual)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let expected_rootfs_metadata = fs::metadata(&expected_rootfs)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let actual_rootfs_metadata = fs::metadata(&actual_rootfs)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let expected_annotations = std::collections::BTreeMap::from([
        (
            "com.firecrawl.bundle".to_owned(),
            expected_bundle_id.as_str().to_owned(),
        ),
        ("com.firecrawl.job".to_owned(), expected_job_id.to_string()),
    ]);
    let pid_is_valid = match state.status {
        RuncState::Stopped => state.pid == 0,
        RuncState::Created | RuncState::Running => {
            state.pid > 0 && state.pid <= i64::from(i32::MAX)
        }
    };
    if state.id != expected_job_id.to_string()
        || !pid_is_valid
        || actual != expected
        || actual_metadata.dev() != expected_metadata.dev()
        || actual_metadata.ino() != expected_metadata.ino()
        || actual_rootfs != expected_rootfs
        || actual_rootfs_metadata.dev() != expected_rootfs_metadata.dev()
        || actual_rootfs_metadata.ino() != expected_rootfs_metadata.ino()
        || state.oci_version != "1.2.0"
        || state.created.is_empty()
        || state.annotations != expected_annotations
        // runc 1.3.6's `state` command marshals containerState without
        // populating Owner. RealRunc separately verifies the owner of the
        // per-container runc state directory, which is the authoritative
        // ownership boundary.
        || !state.owner.is_empty()
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(state)
}

pub fn publish_attestation(
    layout: &JobLayout,
    correlation_id: Uuid,
    init_pid: u32,
) -> BrokerResult<()> {
    let temporary_name = format!(".acceptance-{}.tmp", Uuid::new_v4());
    let temporary = layout.directory.join(&temporary_name);
    let attestation = PreparedAttestation {
        version: 1,
        correlation_id,
        job_id: layout.job_id,
        phase: AttestationPhase::Prepared,
        init_pid,
    };
    let mut file = secure_create(&layout.directory, &temporary_name, 0o600)?;
    serde_json::to_writer(&mut file, &attestation)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    file.write_all(b"\n")
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    file.sync_all()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    fs::rename(&temporary, &layout.attestation_file)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    sync_directory(&layout.directory)
}

pub fn remove_attestation(layout: &JobLayout) -> BrokerResult<()> {
    match fs::remove_file(&layout.attestation_file) {
        Ok(()) => sync_directory(&layout.directory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(BrokerError::with_source(
            ErrorCategory::CleanupFailed,
            error,
        )),
    }
}

pub fn remove_job(layout: &JobLayout) -> BrokerResult<()> {
    if let Some(artifact_directory) = layout.artifact_directory.as_deref()
        && artifact_directory_is_separate_filesystem(&layout.directory, artifact_directory)?
    {
        unmount_artifact_tmpfs(artifact_directory)?;
    }
    if layout.directory.exists() {
        fs::remove_dir_all(&layout.directory)
            .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    }
    Ok(())
}

fn artifact_directory_is_separate_filesystem(
    job_directory: &Path,
    artifact_directory: &Path,
) -> BrokerResult<bool> {
    if !artifact_directory.exists() {
        return Ok(false);
    }
    let parent = fs::metadata(job_directory)
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    let artifact = fs::symlink_metadata(artifact_directory)
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    if !artifact.file_type().is_dir() || artifact.file_type().is_symlink() {
        return Err(BrokerError::new(ErrorCategory::CleanupFailed));
    }
    Ok(parent.dev() != artifact.dev())
}

fn mount_artifact_tmpfs(path: &Path) -> BrokerResult<()> {
    let source = CString::new("firecrawl-artifacts")
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let target = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let filesystem = CString::new("tmpfs")
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let options = CString::new(format!(
        "size={ARTIFACT_TMPFS_BYTES},mode=0700,uid=65532,gid=65532"
    ))
    .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let flags = nix::libc::MS_NOSUID | nix::libc::MS_NODEV | nix::libc::MS_NOEXEC;
    let mounted = unsafe {
        nix::libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            filesystem.as_ptr(),
            flags,
            options.as_ptr().cast(),
        )
    };
    if mounted < 0 {
        return Err(BrokerError::with_source(
            ErrorCategory::SandboxUnavailable,
            std::io::Error::last_os_error(),
        ));
    }
    let made_private = unsafe {
        nix::libc::mount(
            std::ptr::null(),
            target.as_ptr(),
            std::ptr::null(),
            nix::libc::MS_PRIVATE,
            std::ptr::null(),
        )
    };
    if made_private < 0 {
        let error = std::io::Error::last_os_error();
        let _ = unsafe { nix::libc::umount2(target.as_ptr(), 0) };
        return Err(BrokerError::with_source(
            ErrorCategory::SandboxUnavailable,
            error,
        ));
    }
    Ok(())
}

fn unmount_artifact_tmpfs(path: &Path) -> BrokerResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let target = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    let result = unsafe { nix::libc::umount2(target.as_ptr(), 0) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(nix::libc::EINVAL) {
        Ok(())
    } else {
        Err(BrokerError::with_source(
            ErrorCategory::CleanupFailed,
            error,
        ))
    }
}

pub fn read_secure_child(
    directory: &File,
    name: &str,
    maximum: usize,
    required_mode: u32,
    required_uid: u32,
) -> BrokerResult<Vec<u8>> {
    if !safe_basename(name) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let name = CString::new(name)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let how = OpenHow {
        flags: (nix::libc::O_RDONLY | nix::libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: OPENAT2_RESOLVE_BENEATH | OPENAT2_RESOLVE_NO_SYMLINKS,
    };
    let raw = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_openat2,
            directory.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        return Err(BrokerError::with_source(
            ErrorCategory::InvalidRequest,
            std::io::Error::last_os_error(),
        ));
    }
    let file = unsafe { File::from_raw_fd(raw as RawFd) };
    let metadata = file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != required_uid
        || metadata.mode() & 0o777 != required_mode
        || metadata.len() > maximum as u64
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if bytes.len() > maximum {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(bytes)
}

pub fn open_secure_directory(
    path: &Path,
    required_mode: u32,
    required_uid: u32,
) -> BrokerResult<File> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let metadata = directory
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != required_uid
        || metadata.mode() & 0o777 != required_mode
        || metadata.nlink() < 2
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(directory)
}

pub fn collect_artifacts(artifact_root: &Path) -> BrokerResult<Vec<SealedArtifact>> {
    let root = open_artifact_root(artifact_root)?;
    let root_metadata = root
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    validate_artifact_directory(&root_metadata, None)?;

    let mut manifest_file = open_artifact_child(
        &root,
        Path::new("manifest.json"),
        nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
    )?;
    let manifest_metadata = manifest_file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    validate_artifact_file(&manifest_metadata, &root_metadata, 64 * 1024)?;
    let bytes = read_exact_artifact(&mut manifest_file, &manifest_metadata, 64 * 1024)?;
    ensure_fd_identity(&manifest_file, &manifest_metadata)?;
    ensure_named_file_identity(
        &root,
        "manifest.json",
        &manifest_metadata,
        &root_metadata,
        64 * 1024,
    )?;

    let manifest_value = crate::protocol::strict_json_value(&bytes)?;
    let records: Vec<crate::protocol::ArtifactRecord> =
        serde_json::from_value(manifest_value.clone())
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if records.len() > MAX_ARTIFACT_COUNT {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let files_root = open_artifact_child(
        &root,
        Path::new("files"),
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )?;
    let files_metadata = files_root
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    validate_artifact_directory(&files_metadata, Some(&root_metadata))?;

    let mut total = 0_u64;
    let mut ids = std::collections::BTreeSet::new();
    let mut names = std::collections::BTreeSet::new();
    let mut output = Vec::new();
    let manifest_records = manifest_value
        .as_array()
        .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
    for (record, manifest_record) in records.into_iter().zip(manifest_records) {
        if record.artifact_id.is_nil()
            || manifest_record
                .get("artifactId")
                .and_then(Value::as_str)
                .is_none_or(|value| value != record.artifact_id.to_string())
            || !ids.insert(record.artifact_id)
            || !names.insert(record.name.clone())
            || !safe_artifact_name(&record.name)
            || !valid_artifact_kind_content_type(&record.kind, &record.content_type)
            || record.byte_size == 0
            || record.byte_size > MAX_ARTIFACT_BYTES
            || !valid_sha256(&record.checksum)
        {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        total = total
            .checked_add(record.byte_size)
            .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
        if total > MAX_ARTIFACT_TOTAL_BYTES {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }

        let mut source = open_artifact_child(
            &files_root,
            Path::new(&record.name),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        )?;
        let metadata = source
            .metadata()
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
        validate_artifact_file(&metadata, &root_metadata, MAX_ARTIFACT_BYTES)?;
        if metadata.len() != record.byte_size {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        let descriptor = memfd_create(
            format!("firecrawl-artifact-{}", record.artifact_id).as_str(),
            MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING,
        )
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        let mut destination =
            File::from(nix::unistd::dup(&descriptor).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?);
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = source
                .read(&mut buffer)
                .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
            if count == 0 {
                break;
            }
            copied += count as u64;
            if copied > record.byte_size {
                return Err(BrokerError::new(ErrorCategory::InvalidRequest));
            }
            hasher.update(&buffer[..count]);
            destination.write_all(&buffer[..count]).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
        }
        if copied != record.byte_size
            || hex(&hasher.finalize()) != record.checksum
            || !valid_artifact_content(&record.content_type, &destination)
        {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        ensure_fd_identity(&source, &metadata)?;
        ensure_named_file_identity(
            &files_root,
            &record.name,
            &metadata,
            &root_metadata,
            MAX_ARTIFACT_BYTES,
        )?;
        fcntl(
            &descriptor,
            FcntlArg::F_ADD_SEALS(
                SealFlag::F_SEAL_WRITE
                    | SealFlag::F_SEAL_GROW
                    | SealFlag::F_SEAL_SHRINK
                    | SealFlag::F_SEAL_SEAL,
            ),
        )
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        nix::unistd::lseek(&descriptor, 0, nix::unistd::Whence::SeekSet)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        output.push(SealedArtifact { record, descriptor });
    }

    let expected_names = names
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    if directory_names(&root)?
        != std::collections::BTreeSet::from(["files".to_owned(), "manifest.json".to_owned()])
        || directory_names(&files_root)?
            != expected_names
                .into_iter()
                .map(str::to_owned)
                .collect::<std::collections::BTreeSet<_>>()
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    ensure_fd_identity(&root, &root_metadata)?;
    ensure_fd_identity(&files_root, &files_metadata)?;
    ensure_named_directory_identity(&root, "files", &files_metadata, &root_metadata)?;
    ensure_named_file_identity(
        &root,
        "manifest.json",
        &manifest_metadata,
        &root_metadata,
        64 * 1024,
    )?;

    Ok(output)
}

fn valid_artifact_kind_content_type(kind: &str, content_type: &str) -> bool {
    matches!(
        (kind, content_type),
        ("screenshot", "image/png")
            | ("screenshot", "image/jpeg")
            | ("trace", "application/zip")
            | ("recording", "video/webm")
    )
}

fn valid_artifact_content(content_type: &str, file: &File) -> bool {
    let mut prefix = [0_u8; 8];
    let count = unsafe {
        nix::libc::pread(
            file.as_raw_fd(),
            prefix.as_mut_ptr().cast(),
            prefix.len(),
            0,
        )
    };
    if count < 0 {
        return false;
    }
    let prefix = &prefix[..count as usize];
    match content_type {
        "image/png" => prefix.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => prefix.starts_with(&[0xff, 0xd8, 0xff]),
        "application/zip" => {
            prefix.starts_with(b"PK\x03\x04")
                || prefix.starts_with(b"PK\x05\x06")
                || prefix.starts_with(b"PK\x07\x08")
        }
        "video/webm" => prefix.starts_with(b"\x1a\x45\xdf\xa3"),
        _ => false,
    }
}

fn open_artifact_root(path: &Path) -> BrokerResult<File> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let (base_path, relative) = if path.is_absolute() {
        (Path::new("/"), path.strip_prefix("/").unwrap_or(path))
    } else {
        (Path::new("."), path)
    };
    if relative.as_os_str().is_empty() {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let base = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_CLOEXEC)
        .open(base_path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    open_artifact_child(
        &base,
        relative,
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )
}

fn open_artifact_child(directory: &File, path: &Path, flags: i32) -> BrokerResult<File> {
    let name = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let how = OpenHow {
        flags: (flags | nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: OPENAT2_RESOLVE_BENEATH | OPENAT2_RESOLVE_NO_SYMLINKS,
    };
    let raw = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_openat2,
            directory.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        return Err(BrokerError::with_source(
            ErrorCategory::InvalidRequest,
            std::io::Error::last_os_error(),
        ));
    }
    Ok(unsafe { File::from_raw_fd(raw as RawFd) })
}

fn validate_artifact_directory(
    metadata: &fs::Metadata,
    parent: Option<&fs::Metadata>,
) -> BrokerResult<()> {
    if !metadata.file_type().is_dir()
        || metadata.nlink() < 2
        || metadata.mode() & 0o7000 != 0
        || metadata.mode() & 0o500 != 0o500
        || parent
            .is_some_and(|parent| metadata.uid() != parent.uid() || metadata.dev() != parent.dev())
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn validate_artifact_file(
    metadata: &fs::Metadata,
    root_metadata: &fs::Metadata,
    maximum: u64,
) -> BrokerResult<()> {
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != root_metadata.uid()
        || metadata.dev() != root_metadata.dev()
        || metadata.mode() & 0o7000 != 0
        || metadata.mode() & 0o400 == 0
        || metadata.len() > maximum
        || (metadata.len() > 0 && metadata.blocks().saturating_mul(512) < metadata.len())
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn read_exact_artifact(
    file: &mut File,
    metadata: &fs::Metadata,
    maximum: u64,
) -> BrokerResult<Vec<u8>> {
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(bytes)
}

fn ensure_fd_identity(file: &File, expected: &fs::Metadata) -> BrokerResult<()> {
    let actual = file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if !same_artifact_identity(&actual, expected) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn ensure_named_file_identity(
    directory: &File,
    name: &str,
    expected: &fs::Metadata,
    root_metadata: &fs::Metadata,
    maximum: u64,
) -> BrokerResult<()> {
    let file = open_artifact_child(
        directory,
        Path::new(name),
        nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
    )?;
    let actual = file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    validate_artifact_file(&actual, root_metadata, maximum)?;
    if !same_artifact_identity(&actual, expected) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn ensure_named_directory_identity(
    directory: &File,
    name: &str,
    expected: &fs::Metadata,
    root_metadata: &fs::Metadata,
) -> BrokerResult<()> {
    let file = open_artifact_child(
        directory,
        Path::new(name),
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )?;
    let actual = file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    validate_artifact_directory(&actual, Some(root_metadata))?;
    if !same_artifact_identity(&actual, expected) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn same_artifact_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.mode() == right.mode()
        && left.nlink() == right.nlink()
        && left.len() == right.len()
        && left.blocks() == right.blocks()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn directory_names(directory: &File) -> BrokerResult<std::collections::BTreeSet<String>> {
    let directory = open_artifact_child(
        directory,
        Path::new("."),
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )?;
    let mut names = std::collections::BTreeSet::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let count = unsafe {
            nix::libc::syscall(
                nix::libc::SYS_getdents64,
                directory.as_raw_fd(),
                buffer.as_mut_ptr(),
                buffer.len(),
            )
        };
        if count < 0 {
            return Err(BrokerError::with_source(
                ErrorCategory::InvalidRequest,
                std::io::Error::last_os_error(),
            ));
        }
        if count == 0 {
            break;
        }
        let count = count as usize;
        let mut offset = 0;
        while offset < count {
            const DIRENT64_NAME_OFFSET: usize = 19;
            if count - offset < DIRENT64_NAME_OFFSET {
                return Err(BrokerError::new(ErrorCategory::InvalidRequest));
            }
            let record_length =
                u16::from_ne_bytes([buffer[offset + 16], buffer[offset + 17]]) as usize;
            if record_length < DIRENT64_NAME_OFFSET || record_length > count - offset {
                return Err(BrokerError::new(ErrorCategory::InvalidRequest));
            }
            let name_bytes = &buffer[offset + DIRENT64_NAME_OFFSET..offset + record_length];
            let name_length = name_bytes
                .iter()
                .position(|byte| *byte == 0)
                .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
            let name_bytes = &name_bytes[..name_length];
            if name_bytes != b"." && name_bytes != b".." {
                let name = std::str::from_utf8(name_bytes).map_err(|error| {
                    BrokerError::with_source(ErrorCategory::InvalidRequest, error)
                })?;
                if !safe_basename(name) || !names.insert(name.to_owned()) {
                    return Err(BrokerError::new(ErrorCategory::InvalidRequest));
                }
            }
            offset += record_length;
        }
    }
    Ok(names)
}

fn validate_runtime_root(path: &Path) -> BrokerResult<()> {
    validate_secure_directory(path)
}

fn create_or_validate_directory(path: &Path, mode: u32) -> BrokerResult<()> {
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(BrokerError::with_source(
                ErrorCategory::SandboxUnavailable,
                error,
            ));
        }
    }
    validate_secure_directory(path)
}

fn validate_secure_directory(path: &Path) -> BrokerResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o777 != 0o700
        || metadata.nlink() < 2
        || metadata.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(())
}

fn materialize(
    directory: &Path,
    name: &str,
    source: std::os::fd::BorrowedFd<'_>,
    maximum: usize,
) -> BrokerResult<()> {
    let bytes = read_bounded(source, maximum)?;
    let mut destination = secure_create(directory, name, 0o600)?;
    destination
        .write_all(&bytes)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let owner = if nix::unistd::geteuid().is_root() {
        65_532
    } else {
        nix::unistd::geteuid().as_raw()
    };
    nix::unistd::fchown(
        &destination,
        Some(nix::unistd::Uid::from_raw(owner)),
        Some(nix::unistd::Gid::from_raw(owner)),
    )
    .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    destination
        .set_permissions(fs::Permissions::from_mode(0o400))
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    destination
        .sync_all()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))
}

fn secure_create(directory: &Path, name: &str, mode: u32) -> BrokerResult<File> {
    if !safe_basename(name) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let directory_file = File::open(directory)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let name = CString::new(name)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let how = OpenHow {
        flags: (nix::libc::O_CREAT | nix::libc::O_EXCL | nix::libc::O_WRONLY | nix::libc::O_CLOEXEC)
            as u64,
        mode: mode as u64,
        resolve: OPENAT2_RESOLVE_BENEATH | OPENAT2_RESOLVE_NO_SYMLINKS,
    };
    let raw = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_openat2,
            directory_file.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        return Err(BrokerError::with_source(
            ErrorCategory::SandboxUnavailable,
            std::io::Error::last_os_error(),
        ));
    }
    Ok(unsafe { File::from_raw_fd(raw as RawFd) })
}

fn sync_directory(path: &Path) -> BrokerResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))
}

fn safe_basename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.as_bytes().contains(&0)
}

fn safe_artifact_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
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

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
