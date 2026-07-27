use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixListener;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nix::cmsg_space;
use nix::sys::signal::Signal;
use nix::sys::socket::{ControlMessageOwned, MsgFlags, recvmsg};
use serde_json::Value;
use uuid::Uuid;

use crate::bundles::BundlePolicy;
use crate::oci::{
    JobLayout, PRODUCTION_BROKER_CGROUP_PATH, PRODUCTION_CGROUPS_PATH,
    PRODUCTION_SERVICE_CGROUP_PATH, RuncStateRecord, SealedArtifact, collect_artifacts,
    create_job_layout, open_secure_directory, parse_pid_file, parse_runc_state,
    publish_attestation, read_secure_child, remove_attestation, remove_job,
};
use crate::peer::ValidatedDescriptors;
use crate::protocol::{
    BrokerResponse, BundleId, CancelReason, Diagnostic, MAX_JOB_WALL_TIME_MS, Outcome, Phase,
    RuncState,
};
use crate::redaction::{BrokerError, BrokerResult, ErrorCategory};

const RUNC_BINARY: &str = "/usr/bin/runc";
const RUNC_ROOT_NAME: &str = "runc";
const PRODUCTION_RUNTIME_ROOT: &str = "/run/firecrawl-sandbox";
const CGROUP_FILESYSTEM_ROOT: &str = "/sys/fs/cgroup";
const COMMAND_KILL_BOUND: Duration = Duration::from_secs(2);
const PIDFD_EXIT_BOUND: Duration = Duration::from_secs(2);
const TERMINAL_RECORD_LIMIT: usize = 128;
const COMMAND_OUTPUT_BOUND: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OwnerKey {
    pub uid: u32,
    pub adapter_boot_id: Uuid,
    pub job_id: Uuid,
}

#[derive(Clone, Debug)]
pub struct PreparedLease {
    owner: OwnerKey,
    correlation_id: Uuid,
    lease_id: u64,
    init_pid: u32,
    deadline: Instant,
}

impl PreparedLease {
    pub const fn job_id(&self) -> Uuid {
        self.owner.job_id
    }

    pub const fn init_pid(&self) -> u32 {
        self.init_pid
    }

    pub const fn correlation_id(&self) -> Uuid {
        self.correlation_id
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }
}

#[derive(Debug)]
pub struct ProcessIdentity {
    pid: u32,
    pidfd: OwnedFd,
}

impl ProcessIdentity {
    pub fn from_received(pid: u32, pidfd: OwnedFd) -> BrokerResult<Self> {
        if pid == 0 || pidfd_pid(pidfd.as_fd())? != pid || !pidfd_live(pidfd.as_fd()) {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        Ok(Self { pid, pidfd })
    }

    pub fn open_for_test(pid: u32) -> BrokerResult<Self> {
        let raw = unsafe { nix::libc::syscall(nix::libc::SYS_pidfd_open, pid, 0) };
        if raw < 0 {
            return Err(BrokerError::with_source(
                ErrorCategory::SandboxUnavailable,
                std::io::Error::last_os_error(),
            ));
        }
        Self::from_received(pid, unsafe { OwnedFd::from_raw_fd(raw as i32) })
    }

    pub const fn pid(&self) -> u32 {
        self.pid
    }

    pub fn validate(&self) -> BrokerResult<()> {
        if pidfd_pid(self.pidfd.as_fd())? != self.pid || !pidfd_live(self.pidfd.as_fd()) {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        Ok(())
    }

    pub fn exited(&self) -> bool {
        !pidfd_live(self.pidfd.as_fd())
    }

    fn duplicate_pidfd(&self) -> BrokerResult<OwnedFd> {
        nix::unistd::dup(&self.pidfd)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))
    }
}

pub trait Runc: Send + Sync + 'static {
    fn create(
        &self,
        layout: &JobLayout,
        bundle: BundleId,
        descriptors: &[OwnedFd],
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> BrokerResult<ProcessIdentity>;

    fn state(&self, layout: &JobLayout) -> BrokerResult<Option<RuncStateRecord>>;

    fn configure_created_network(
        &self,
        layout: &JobLayout,
        bundle: BundleId,
        identity: &ProcessIdentity,
    ) -> BrokerResult<()>;

    fn start(
        &self,
        layout: &JobLayout,
        identity: &ProcessIdentity,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> BrokerResult<()>;

    fn kill(&self, layout: &JobLayout, signal: Signal) -> BrokerResult<()>;

    fn delete_force(&self, layout: &JobLayout) -> BrokerResult<()>;

    fn list(&self, runtime_root: &Path) -> BrokerResult<Vec<Uuid>>;
}

#[derive(Clone, Debug)]
pub struct RealRunc {
    runtime_root: PathBuf,
}

impl RealRunc {
    pub fn new(runtime_root: PathBuf) -> Self {
        Self { runtime_root }
    }

    fn root(&self) -> PathBuf {
        self.runtime_root.join(RUNC_ROOT_NAME)
    }

    fn base_command(&self) -> Command {
        let mut command = Command::new(RUNC_BINARY);
        command
            .arg("--root")
            .arg(self.root())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .env("LC_ALL", "C.UTF-8");
        command
    }

    fn validate_state_directory_owner(&self, job_id: Uuid) -> BrokerResult<()> {
        for path in [self.root(), self.root().join(job_id.to_string())] {
            let metadata = fs::symlink_metadata(path).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            if !metadata.file_type().is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != 0
            {
                return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
            }
        }
        Ok(())
    }

    fn list_internal(&self) -> BrokerResult<Vec<Uuid>> {
        let mut command = self.base_command();
        command
            .arg("list")
            .arg("--format")
            .arg("json")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let output = run_output_bounded(command, COMMAND_KILL_BOUND, ErrorCategory::CleanupFailed)?;
        if !output.status.success() {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        let value: Value = crate::protocol::strict_json(&output.stdout)?;
        let entries = value
            .as_array()
            .ok_or_else(|| BrokerError::new(ErrorCategory::CleanupFailed))?;
        entries
            .iter()
            .map(|entry| {
                let id = entry
                    .as_object()
                    .and_then(|entry| entry.get("id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| BrokerError::new(ErrorCategory::CleanupFailed))?;
                Uuid::parse_str(id)
                    .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))
            })
            .collect()
    }
}

impl Runc for RealRunc {
    fn create(
        &self,
        layout: &JobLayout,
        bundle: BundleId,
        descriptors: &[OwnedFd],
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> BrokerResult<ProcessIdentity> {
        BundlePolicy::load(bundle)?.validate_installed_rootfs()?;
        let _ = fs::remove_file(&layout.pidfd_socket);
        let listener = UnixListener::bind(&layout.pidfd_socket)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        fs::set_permissions(
            &layout.pidfd_socket,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;

        let mut command = self.base_command();
        command
            .arg("create")
            .arg("--bundle")
            .arg(&layout.directory)
            .arg("--pid-file")
            .arg(&layout.pid_file)
            .arg("--pidfd-socket")
            .arg(&layout.pidfd_socket);
        if bundle != BundleId::CodexV1 {
            command.arg("--preserve-fds").arg("1");
        }
        command.arg(layout.job_id.to_string());
        configure_create_fds(&mut command, bundle, descriptors)?;
        let mut child = command
            .spawn()
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        let status = wait_child(&mut child, deadline, cancelled, None)?;
        if !status.success() {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        let accept_deadline = Instant::now() + COMMAND_KILL_BOUND;
        let connection = loop {
            match listener.accept() {
                Ok((connection, _)) => break connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= accept_deadline || cancelled.load(Ordering::Acquire) {
                        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => {
                    return Err(BrokerError::with_source(
                        ErrorCategory::SandboxUnavailable,
                        error,
                    ));
                }
            }
        };
        let pidfd = receive_exact_pidfd(connection.as_raw_fd())?;
        fs::remove_file(&layout.pidfd_socket)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        let job_directory =
            open_secure_directory(&layout.directory, 0o700, nix::unistd::geteuid().as_raw())?;
        let pid_bytes = read_secure_child(
            &job_directory,
            "pid",
            32,
            0o600,
            nix::unistd::geteuid().as_raw(),
        )?;
        let pid = parse_pid_file(&pid_bytes)?;
        ProcessIdentity::from_received(pid, pidfd)
    }

    fn state(&self, layout: &JobLayout) -> BrokerResult<Option<RuncStateRecord>> {
        let mut command = self.base_command();
        command
            .arg("state")
            .arg(layout.job_id.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let output = run_output_bounded(
            command,
            COMMAND_KILL_BOUND,
            ErrorCategory::SandboxUnavailable,
        )?;
        if !output.status.success() {
            return if self.list_internal()?.contains(&layout.job_id) {
                Err(BrokerError::new(ErrorCategory::SandboxUnavailable))
            } else {
                Ok(None)
            };
        }
        self.validate_state_directory_owner(layout.job_id)?;
        parse_runc_state(
            &output.stdout,
            layout.job_id,
            &layout.directory,
            &layout.rootfs,
            layout.bundle_id,
        )
        .map(Some)
    }

    fn configure_created_network(
        &self,
        _layout: &JobLayout,
        bundle: BundleId,
        identity: &ProcessIdentity,
    ) -> BrokerResult<()> {
        if bundle == BundleId::CodexV1 {
            return Ok(());
        }
        identity.validate()?;
        let namespace = fs::OpenOptions::new()
            .read(true)
            .open(format!("/proc/{}/ns/net", identity.pid()))
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        identity.validate()?;
        let namespace_fd = namespace.as_raw_fd();
        let mut command = Command::new("/usr/bin/nsenter");
        command
            .args([
                "--net=/proc/self/fd/3",
                "--",
                "/usr/sbin/ip",
                "link",
                "set",
                "lo",
                "up",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/usr/sbin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                if nix::libc::dup2(namespace_fd, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let result = nix::libc::syscall(
                    nix::libc::SYS_close_range,
                    3_u32,
                    u32::MAX,
                    nix::libc::CLOSE_RANGE_CLOEXEC,
                );
                if result < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let flags = nix::libc::fcntl(3, nix::libc::F_GETFD);
                if flags < 0
                    || nix::libc::fcntl(3, nix::libc::F_SETFD, flags & !nix::libc::FD_CLOEXEC) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let status = run_status_bounded(
            command,
            COMMAND_KILL_BOUND,
            ErrorCategory::SandboxUnavailable,
        )?;
        identity.validate()?;
        if !status.success() {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        Ok(())
    }

    fn start(
        &self,
        layout: &JobLayout,
        identity: &ProcessIdentity,
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> BrokerResult<()> {
        let mut child = self
            .base_command()
            .arg("start")
            .arg(layout.job_id.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        let status = wait_child(&mut child, deadline, cancelled, Some(identity))?;
        if status.success() {
            Ok(())
        } else {
            Err(BrokerError::new(ErrorCategory::SandboxUnavailable))
        }
    }

    fn kill(&self, layout: &JobLayout, signal: Signal) -> BrokerResult<()> {
        let mut command = self.base_command();
        command
            .arg("kill")
            .arg(layout.job_id.to_string())
            .arg(match signal {
                Signal::SIGTERM => "TERM",
                Signal::SIGKILL => "KILL",
                _ => return Err(BrokerError::new(ErrorCategory::InvalidRequest)),
            })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = run_status_bounded(command, COMMAND_KILL_BOUND, ErrorCategory::CleanupFailed)?;
        if status.success() {
            Ok(())
        } else {
            Err(BrokerError::new(ErrorCategory::CleanupFailed))
        }
    }

    fn delete_force(&self, layout: &JobLayout) -> BrokerResult<()> {
        let mut command = self.base_command();
        command
            .arg("delete")
            .arg("--force")
            .arg(layout.job_id.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = run_status_bounded(command, COMMAND_KILL_BOUND, ErrorCategory::CleanupFailed)?;
        if status.success() {
            Ok(())
        } else {
            Err(BrokerError::new(ErrorCategory::CleanupFailed))
        }
    }

    fn list(&self, _runtime_root: &Path) -> BrokerResult<Vec<Uuid>> {
        self.list_internal()
    }
}

pub struct BrokerRuntime<R: Runc> {
    runtime_root: PathBuf,
    runc: Arc<R>,
    jobs: Mutex<HashMap<OwnerKey, Arc<Job>>>,
    revoked_owners: Mutex<HashSet<(u32, Uuid)>>,
    terminal: Mutex<VecDeque<TerminalRecord>>,
    next_lease: AtomicU64,
    healthy: AtomicBool,
}

struct Job {
    owner: OwnerKey,
    correlation_id: Uuid,
    bundle: BundleId,
    deadline: Instant,
    lease_id: u64,
    operation: Mutex<()>,
    state: Mutex<JobState>,
    cancelled: AtomicBool,
    layout: Mutex<Option<JobLayout>>,
    descriptors: Mutex<Option<Vec<OwnedFd>>>,
    identity: Mutex<Option<ProcessIdentity>>,
}

#[derive(Clone, Debug)]
struct JobState {
    phase: Phase,
    control_lease_connected: bool,
    cancellation_reason: Option<CancelReason>,
    cleanup_failure: bool,
    last_runc_state: Option<RuncState>,
}

#[derive(Clone, Debug)]
struct TerminalRecord {
    uid: u32,
    correlation_id: Uuid,
    job_id: Uuid,
    diagnostic: Diagnostic,
}

impl<R: Runc> BrokerRuntime<R> {
    pub fn new(runtime_root: PathBuf, runc: Arc<R>) -> Self {
        Self {
            runtime_root,
            runc,
            jobs: Mutex::new(HashMap::new()),
            revoked_owners: Mutex::new(HashSet::new()),
            terminal: Mutex::new(VecDeque::new()),
            next_lease: AtomicU64::new(1),
            healthy: AtomicBool::new(true),
        }
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        &self,
        uid: u32,
        adapter_boot_id: Uuid,
        job_id: Uuid,
        correlation_id: Uuid,
        bundle: BundleId,
        deadline_unix_ms: u64,
        descriptors: ValidatedDescriptors,
    ) -> BrokerResult<PreparedLease> {
        if !self.is_healthy() {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        if deadline_expired(deadline_unix_ms) {
            return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
        }
        if !deadline_allowed(deadline_unix_ms) {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        if descriptors.bundle_id() != bundle {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        let deadline = monotonic_deadline(deadline_unix_ms)?;
        let owner = OwnerKey {
            uid,
            adapter_boot_id,
            job_id,
        };
        let lease_id = self.next_lease.fetch_add(1, Ordering::Relaxed);
        let job = Arc::new(Job {
            owner: owner.clone(),
            correlation_id,
            bundle,
            deadline,
            lease_id,
            operation: Mutex::new(()),
            state: Mutex::new(JobState {
                phase: Phase::Creating,
                control_lease_connected: true,
                cancellation_reason: None,
                cleanup_failure: false,
                last_runc_state: None,
            }),
            cancelled: AtomicBool::new(false),
            layout: Mutex::new(None),
            descriptors: Mutex::new(Some(descriptors.take())),
            identity: Mutex::new(None),
        });
        {
            let mut jobs = lock(&self.jobs)?;
            if lock(&self.revoked_owners)?.contains(&(uid, adapter_boot_id)) {
                return Err(BrokerError::new(ErrorCategory::Unauthorized));
            }
            let terminal_reuse = lock(&self.terminal)?
                .iter()
                .any(|record| record.job_id == job_id);
            if terminal_reuse || jobs.keys().any(|key| key.job_id == job_id) {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
            jobs.insert(owner.clone(), Arc::clone(&job));
        }
        let _operation = lock(&job.operation)?;
        let result = self.prepare_locked(&job, correlation_id);
        match result {
            Ok(init_pid) => Ok(PreparedLease {
                owner,
                correlation_id,
                lease_id,
                init_pid,
                deadline,
            }),
            Err(error) => {
                let cleanup = self.cleanup(&job, Outcome::Failed);
                if error.category() == ErrorCategory::CleanupFailed || cleanup.is_err() {
                    self.healthy.store(false, Ordering::Release);
                    Err(BrokerError::new(ErrorCategory::CleanupFailed))
                } else {
                    Err(error)
                }
            }
        }
    }

    fn prepare_locked(&self, job: &Arc<Job>, correlation_id: Uuid) -> BrokerResult<u32> {
        let policy = BundlePolicy::load(job.bundle)?;
        let layout = {
            let descriptors = lock(&job.descriptors)?;
            let descriptors = descriptors
                .as_ref()
                .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
            let validated = borrowed_validated(job.bundle, descriptors)?;
            create_job_layout(&self.runtime_root, job.owner.job_id, &policy, &validated)?
        };
        *lock(&job.layout)? = Some(layout);
        let layout_guard = lock(&job.layout)?;
        let layout = layout_guard
            .as_ref()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        let identity = {
            let descriptors = lock(&job.descriptors)?;
            let descriptors = descriptors
                .as_ref()
                .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
            self.runc.create(
                layout,
                job.bundle,
                descriptors,
                job.deadline,
                &job.cancelled,
            )?
        };
        if job.cancelled.load(Ordering::Acquire) || Instant::now() >= job.deadline {
            return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
        }
        identity.validate()?;
        let directory =
            open_secure_directory(&layout.directory, 0o700, nix::unistd::geteuid().as_raw())?;
        let pid_file = read_secure_child(
            &directory,
            "pid",
            32,
            0o600,
            nix::unistd::geteuid().as_raw(),
        )?;
        let file_pid = parse_pid_file(&pid_file)?;
        let state = self
            .runc
            .state(layout)?
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        if state.status != RuncState::Created
            || state.pid as u32 != identity.pid()
            || file_pid != identity.pid()
        {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        self.runc
            .configure_created_network(layout, job.bundle, &identity)?;
        if job.cancelled.load(Ordering::Acquire) || Instant::now() >= job.deadline {
            return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
        }
        identity.validate()?;
        let init_pid = identity.pid();
        *lock(&job.identity)? = Some(identity);
        let mut state_guard = lock(&job.state)?;
        if state_guard.phase != Phase::Creating || job.cancelled.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::Conflict));
        }
        publish_attestation(layout, correlation_id, init_pid)?;
        state_guard.phase = Phase::Prepared;
        state_guard.last_runc_state = Some(RuncState::Created);
        Ok(init_pid)
    }

    pub fn start(
        &self,
        uid: u32,
        lease: &PreparedLease,
        expected_init_pid: u32,
    ) -> BrokerResult<BrokerResponse> {
        let job = self.exact_lease(uid, lease)?;
        let _operation = lock(&job.operation)?;
        let layout_guard = lock(&job.layout)?;
        let layout = layout_guard
            .as_ref()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        {
            let mut state = lock(&job.state)?;
            if state.phase != Phase::Prepared
                || expected_init_pid != lease.init_pid
                || job.cancelled.load(Ordering::Acquire)
            {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
            remove_attestation(layout)?;
            state.phase = Phase::Starting;
        }
        let identity_guard = lock(&job.identity)?;
        let identity = identity_guard
            .as_ref()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        identity.validate()?;
        let before = self
            .runc
            .state(layout)?
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        if before.status != RuncState::Created
            || before.pid as u32 != expected_init_pid
            || Instant::now() >= job.deadline
        {
            drop(identity_guard);
            drop(layout_guard);
            self.cleanup(&job, Outcome::Failed)?;
            return Err(BrokerError::new(ErrorCategory::Conflict));
        }
        let start_result = self
            .runc
            .start(layout, identity, job.deadline, &job.cancelled);
        if start_result
            .as_ref()
            .is_err_and(|error| error.category() == ErrorCategory::CleanupFailed)
        {
            self.healthy.store(false, Ordering::Release);
            if let Ok(mut state) = lock(&job.state) {
                state.cleanup_failure = true;
                state.phase = Phase::Stopping;
            }
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        let deadline_won = Instant::now() >= job.deadline;
        if deadline_won {
            let mut state = lock(&job.state)?;
            state.cancellation_reason = Some(CancelReason::TimedOut);
            job.cancelled.store(true, Ordering::Release);
        }
        if start_result.is_err() || job.cancelled.load(Ordering::Acquire) {
            if job.cancelled.load(Ordering::Acquire) && !deadline_won {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
            drop(identity_guard);
            drop(layout_guard);
            self.cleanup(&job, cancellation_outcome(&job))?;
            if deadline_won {
                return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
            }
            return Err(start_result
                .err()
                .unwrap_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable)));
        }
        identity.validate()?;
        let after = self
            .runc
            .state(layout)?
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
        let deadline_won = Instant::now() >= job.deadline;
        if deadline_won {
            let mut state = lock(&job.state)?;
            state.cancellation_reason = Some(CancelReason::TimedOut);
            job.cancelled.store(true, Ordering::Release);
        }
        if after.status != RuncState::Running
            || after.pid as u32 != expected_init_pid
            || job.cancelled.load(Ordering::Acquire)
        {
            drop(identity_guard);
            drop(layout_guard);
            self.cleanup(
                &job,
                if deadline_won {
                    Outcome::TimedOut
                } else {
                    Outcome::Failed
                },
            )?;
            return Err(BrokerError::new(if deadline_won {
                ErrorCategory::DeadlineExceeded
            } else {
                ErrorCategory::SandboxUnavailable
            }));
        }
        drop(identity_guard);
        drop(layout_guard);
        let mut state = lock(&job.state)?;
        if job.cancelled.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::Conflict));
        }
        state.phase = Phase::Running;
        state.last_runc_state = Some(RuncState::Running);
        Ok(BrokerResponse::Started {
            job_id: job.owner.job_id,
            init_pid: expected_init_pid,
        })
    }

    pub fn abort(
        &self,
        uid: u32,
        lease: &PreparedLease,
        reason: CancelReason,
    ) -> BrokerResult<BrokerResponse> {
        let job = self.exact_lease(uid, lease)?;
        {
            let mut state = lock(&job.state)?;
            if !matches!(state.phase, Phase::Creating | Phase::Prepared) {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
            state.cancellation_reason = Some(reason);
            job.cancelled.store(true, Ordering::Release);
        }
        let _operation = lock(&job.operation)?;
        self.cleanup(&job, cancellation_outcome(&job))?;
        Ok(BrokerResponse::Aborted {
            job_id: job.owner.job_id,
        })
    }

    pub fn cancel(
        &self,
        uid: u32,
        lease: &PreparedLease,
        adapter_boot_id: Uuid,
        reason: CancelReason,
    ) -> BrokerResult<BrokerResponse> {
        if adapter_boot_id != lease.owner.adapter_boot_id {
            return Err(BrokerError::new(ErrorCategory::Unauthorized));
        }
        let job = self.exact_lease(uid, lease)?;
        {
            let mut state = lock(&job.state)?;
            if matches!(state.phase, Phase::Stopping | Phase::Terminal) {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
            state.cancellation_reason = Some(reason);
            job.cancelled.store(true, Ordering::Release);
        }
        let _operation = lock(&job.operation)?;
        let outcome = cancellation_outcome(&job);
        let init_pid = lock(&job.identity)?
            .as_ref()
            .map(ProcessIdentity::pid)
            .unwrap_or(lease.init_pid);
        self.cleanup(&job, outcome)?;
        Ok(BrokerResponse::Terminal {
            job_id: job.owner.job_id,
            init_pid,
            outcome,
            artifacts: Vec::new(),
        })
    }

    pub fn finish(
        &self,
        uid: u32,
        lease: &PreparedLease,
        adapter_boot_id: Uuid,
        reason: CancelReason,
    ) -> BrokerResult<(BrokerResponse, Vec<SealedArtifact>)> {
        if adapter_boot_id != lease.owner.adapter_boot_id {
            return Err(BrokerError::new(ErrorCategory::Unauthorized));
        }
        let job = self.exact_lease(uid, lease)?;
        {
            let mut state = lock(&job.state)?;
            if matches!(state.phase, Phase::Stopping | Phase::Terminal) {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
            state.cancellation_reason = Some(reason);
            job.cancelled.store(true, Ordering::Release);
        }
        let _operation = lock(&job.operation)?;
        let mut outcome = if reason == CancelReason::Shutdown {
            Outcome::Completed
        } else {
            cancellation_outcome(&job)
        };
        let init_pid = lock(&job.identity)?
            .as_ref()
            .map(ProcessIdentity::pid)
            .unwrap_or(lease.init_pid);
        let artifacts = if outcome == Outcome::Completed && job.bundle != BundleId::CodexV1 {
            let artifact_root = lock(&job.layout)?
                .as_ref()
                .and_then(|layout| layout.artifact_directory.clone())
                .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
            match collect_artifacts(&artifact_root) {
                Ok(artifacts) => artifacts,
                Err(_) => {
                    outcome = Outcome::Failed;
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        let records = artifacts
            .iter()
            .map(|artifact| artifact.record.clone())
            .collect();
        self.cleanup(&job, outcome)?;
        Ok((
            BrokerResponse::Terminal {
                job_id: job.owner.job_id,
                init_pid,
                outcome,
                artifacts: records,
            },
            artifacts,
        ))
    }

    pub fn connection_eof(&self, uid: u32, lease: &PreparedLease) -> BrokerResult<()> {
        let job = self.exact_lease(uid, lease)?;
        {
            let mut state = lock(&job.state)?;
            state.control_lease_connected = false;
            state.cancellation_reason = Some(CancelReason::ProtocolError);
            job.cancelled.store(true, Ordering::Release);
        }
        let _operation = lock(&job.operation)?;
        self.cleanup(&job, Outcome::Cancelled)
    }

    pub fn monitor_pidfd(&self, uid: u32, lease: &PreparedLease) -> BrokerResult<OwnedFd> {
        let job = self.exact_lease(uid, lease)?;
        lock(&job.identity)?
            .as_ref()
            .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))?
            .duplicate_pidfd()
    }

    pub fn init_died(&self, uid: u32, lease: &PreparedLease) -> BrokerResult<BrokerResponse> {
        let job = self.exact_lease(uid, lease)?;
        {
            let identity = lock(&job.identity)?;
            if identity.as_ref().is_none_or(|identity| !identity.exited()) {
                return Err(BrokerError::new(ErrorCategory::Conflict));
            }
        }
        {
            let mut state = lock(&job.state)?;
            state.cancellation_reason = Some(CancelReason::ProtocolError);
            job.cancelled.store(true, Ordering::Release);
        }
        let _operation = lock(&job.operation)?;
        let init_pid = lock(&job.identity)?
            .as_ref()
            .map(ProcessIdentity::pid)
            .unwrap_or(lease.init_pid);
        self.cleanup(&job, Outcome::Failed)?;
        Ok(BrokerResponse::Terminal {
            job_id: job.owner.job_id,
            init_pid,
            outcome: Outcome::Failed,
            artifacts: Vec::new(),
        })
    }

    pub fn timeout(&self, uid: u32, lease: &PreparedLease) -> BrokerResult<BrokerResponse> {
        let job = self.exact_lease(uid, lease)?;
        {
            let mut state = lock(&job.state)?;
            state.cancellation_reason = Some(CancelReason::TimedOut);
            job.cancelled.store(true, Ordering::Release);
        }
        let _operation = lock(&job.operation)?;
        let init_pid = lock(&job.identity)?
            .as_ref()
            .map(ProcessIdentity::pid)
            .unwrap_or(lease.init_pid);
        self.cleanup(&job, Outcome::TimedOut)?;
        Ok(BrokerResponse::Terminal {
            job_id: job.owner.job_id,
            init_pid,
            outcome: Outcome::TimedOut,
            artifacts: Vec::new(),
        })
    }

    pub fn cancel_owner(
        &self,
        uid: u32,
        prior_adapter_boot_id: Uuid,
    ) -> BrokerResult<BrokerResponse> {
        let jobs = {
            let jobs = lock(&self.jobs)?;
            lock(&self.revoked_owners)?.insert((uid, prior_adapter_boot_id));
            jobs.values()
                .filter(|job| {
                    job.owner.uid == uid && job.owner.adapter_boot_id == prior_adapter_boot_id
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for job in &jobs {
            {
                let mut state = lock(&job.state)?;
                state.cancellation_reason = Some(CancelReason::Shutdown);
                job.cancelled.store(true, Ordering::Release);
            }
        }
        let mut failed = false;
        for job in jobs {
            let _operation = lock(&job.operation)?;
            failed |= self.cleanup(&job, Outcome::Cancelled).is_err();
        }
        if failed {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        Ok(BrokerResponse::OwnerCancelled)
    }

    pub fn request_cancel_key(
        &self,
        uid: u32,
        adapter_boot_id: Uuid,
        job_id: Uuid,
        reason: CancelReason,
    ) -> BrokerResult<()> {
        let key = OwnerKey {
            uid,
            adapter_boot_id,
            job_id,
        };
        let job = lock(&self.jobs)?
            .get(&key)
            .cloned()
            .ok_or_else(|| BrokerError::new(ErrorCategory::Conflict))?;
        let mut state = lock(&job.state)?;
        state.control_lease_connected = false;
        state.cancellation_reason = Some(reason);
        job.cancelled.store(true, Ordering::Release);
        Ok(())
    }

    pub fn request_cancel_lease(
        &self,
        uid: u32,
        lease: &PreparedLease,
        reason: CancelReason,
    ) -> BrokerResult<()> {
        let job = self.exact_lease(uid, lease)?;
        let mut state = lock(&job.state)?;
        state.control_lease_connected = false;
        state.cancellation_reason = Some(reason);
        job.cancelled.store(true, Ordering::Release);
        Ok(())
    }

    pub fn diagnose(
        &self,
        uid: u32,
        correlation_id: Uuid,
        job_id: Uuid,
    ) -> BrokerResult<Diagnostic> {
        {
            let jobs = lock(&self.jobs)?;
            if let Some(job) = jobs.values().find(|job| {
                job.owner.uid == uid
                    && job.owner.job_id == job_id
                    && job.correlation_id == correlation_id
            }) {
                return self.live_diagnostic(job);
            }
        }
        let terminal = lock(&self.terminal)?;
        terminal
            .iter()
            .rev()
            .find(|record| {
                record.uid == uid
                    && record.job_id == job_id
                    && record.correlation_id == correlation_id
            })
            .map(|record| record.diagnostic.clone())
            .ok_or_else(|| BrokerError::new(ErrorCategory::Unauthorized))
    }

    pub fn reconcile_orphans(&self) -> BrokerResult<()> {
        if self.runtime_root == Path::new(PRODUCTION_RUNTIME_ROOT) {
            prepare_production_cgroup_tree()?;
        }
        let ids = self.runc.list(&self.runtime_root)?;
        let jobs_root = self.runtime_root.join("jobs");
        for job_id in ids {
            let layout = layout_for_existing(&jobs_root, job_id);
            let _ = self.runc.kill(&layout, Signal::SIGKILL);
            self.runc.delete_force(&layout)?;
            remove_job(&layout)?;
        }
        if jobs_root.exists() {
            for entry in fs::read_dir(&jobs_root)
                .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?
            {
                let entry = entry.map_err(|error| {
                    BrokerError::with_source(ErrorCategory::CleanupFailed, error)
                })?;
                let name = entry.file_name();
                let name = name
                    .to_str()
                    .ok_or_else(|| BrokerError::new(ErrorCategory::CleanupFailed))?;
                let job_id = Uuid::parse_str(name).map_err(|error| {
                    BrokerError::with_source(ErrorCategory::CleanupFailed, error)
                })?;
                if name != job_id.to_string() {
                    return Err(BrokerError::new(ErrorCategory::CleanupFailed));
                }
                remove_job(&layout_for_existing(&jobs_root, job_id))?;
            }
        }
        let remaining = self.runc.list(&self.runtime_root)?;
        let cgroup_clean = if self.runtime_root == Path::new(PRODUCTION_RUNTIME_ROOT) {
            reconcile_production_cgroups()
        } else {
            Ok(())
        };
        if !remaining.is_empty() || cgroup_clean.is_err() {
            self.healthy.store(false, Ordering::Release);
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        Ok(())
    }

    fn exact_lease(&self, uid: u32, lease: &PreparedLease) -> BrokerResult<Arc<Job>> {
        if uid != lease.owner.uid {
            return Err(BrokerError::new(ErrorCategory::Unauthorized));
        }
        let jobs = lock(&self.jobs)?;
        let job = jobs
            .get(&lease.owner)
            .cloned()
            .ok_or_else(|| BrokerError::new(ErrorCategory::Conflict))?;
        if job.lease_id != lease.lease_id || job.correlation_id != lease.correlation_id {
            return Err(BrokerError::new(ErrorCategory::Conflict));
        }
        Ok(job)
    }

    fn cleanup(&self, job: &Arc<Job>, outcome: Outcome) -> BrokerResult<()> {
        {
            let mut state = lock(&job.state)?;
            if state.phase == Phase::Terminal {
                return Ok(());
            }
            if state.cleanup_failure {
                return Err(BrokerError::new(ErrorCategory::CleanupFailed));
            }
            state.phase = Phase::Stopping;
        }
        let mut cleanup_failed = false;
        let layout_guard = lock(&job.layout)?;
        if let Some(layout) = layout_guard.as_ref() {
            cleanup_failed |= remove_attestation(layout).is_err();
            let container_exists = match self.runc.state(layout) {
                Ok(Some(state)) if state.status == RuncState::Running => {
                    cleanup_failed |= self.runc.kill(layout, Signal::SIGTERM).is_err();
                    let exited = lock(&job.identity)?
                        .as_ref()
                        .is_none_or(|identity| wait_pidfd_exit(identity, PIDFD_EXIT_BOUND));
                    if !exited {
                        cleanup_failed |= self.runc.kill(layout, Signal::SIGKILL).is_err();
                    }
                    true
                }
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(_) => {
                    cleanup_failed = true;
                    true
                }
            };
            if container_exists {
                cleanup_failed |= self.runc.delete_force(layout).is_err();
                match self.runc.state(layout) {
                    Ok(None) => {}
                    Ok(Some(_)) | Err(_) => cleanup_failed = true,
                }
            }
            if self.runtime_root == Path::new(PRODUCTION_RUNTIME_ROOT)
                && cleanup_production_cgroup(job.owner.job_id).is_err()
            {
                cleanup_failed = true;
            }
            if let Some(identity) = lock(&job.identity)?.as_ref()
                && !wait_pidfd_exit(identity, PIDFD_EXIT_BOUND)
            {
                cleanup_failed = true;
            }
            cleanup_failed |= remove_job(layout).is_err();
        }
        drop(layout_guard);
        let diagnostic = {
            let mut state = lock(&job.state)?;
            state.phase = Phase::Terminal;
            state.cleanup_failure = cleanup_failed;
            match self.observed_diagnostic(job, &state) {
                Ok(diagnostic) => diagnostic,
                Err(_) => {
                    cleanup_failed = true;
                    state.cleanup_failure = true;
                    unavailable_terminal_diagnostic(job)
                }
            }
        };
        lock(&job.descriptors)?.take();
        lock(&job.identity)?.take();
        lock(&self.jobs)?.remove(&job.owner);
        let mut terminal = lock(&self.terminal)?;
        terminal.push_back(TerminalRecord {
            uid: job.owner.uid,
            correlation_id: job.correlation_id,
            job_id: job.owner.job_id,
            diagnostic,
        });
        while terminal.len() > TERMINAL_RECORD_LIMIT {
            terminal.pop_front();
        }
        if cleanup_failed {
            self.healthy.store(false, Ordering::Release);
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        let _ = outcome;
        Ok(())
    }

    fn live_diagnostic(&self, job: &Arc<Job>) -> BrokerResult<Diagnostic> {
        let state = lock(&job.state)?.clone();
        if state.cleanup_failure {
            return Ok(fail_stop_diagnostic(job, state.phase));
        }
        self.observed_diagnostic(job, &state)
    }

    fn observed_diagnostic(&self, job: &Job, state: &JobState) -> BrokerResult<Diagnostic> {
        let (runc_state, job_directory_present) = {
            let layout = lock(&job.layout)?;
            match layout.as_ref() {
                Some(layout) => (
                    self.runc.state(layout)?.map(|state| state.status),
                    layout.directory.exists(),
                ),
                None => (None, false),
            }
        };
        let (init_pid, pidfd_live, pidfd_pid_matches) = {
            let identity = lock(&job.identity)?;
            (
                identity.as_ref().map(ProcessIdentity::pid),
                identity.as_ref().is_some_and(|identity| !identity.exited()),
                identity
                    .as_ref()
                    .is_some_and(|identity| identity.validate().is_ok()),
            )
        };
        let inert_relay_fd_present = {
            let descriptors = lock(&job.descriptors)?;
            match (job.bundle, init_pid, descriptors.as_ref()) {
                (BundleId::CodexV1, _, _) => false,
                (_, Some(pid), Some(descriptors)) => relay_fd_matches(pid, &descriptors[3]),
                _ => false,
            }
        };
        let relay_listener_present = init_pid
            .is_some_and(|pid| namespace_path_is_socket(pid, "run/firecrawl-job/relay.sock"));
        let cdp_relay_opened =
            init_pid.is_some_and(|pid| namespace_path_is_file(pid, "run/firecrawl-job/cdp.opened"));
        let payload_marker_present = init_pid
            .is_some_and(|pid| namespace_path_is_file(pid, "run/firecrawl-job/payload.marker"));
        let cgroup = (self.runtime_root == Path::new(PRODUCTION_RUNTIME_ROOT))
            .then(|| production_cgroup_path(job.owner.job_id));
        Ok(Diagnostic {
            correlation_id: job.correlation_id,
            job_id: job.owner.job_id,
            phase: state.phase,
            init_pid,
            pidfd_live,
            pidfd_pid_matches,
            control_lease_connected: state.control_lease_connected,
            inert_relay_fd_present,
            relay_listener_present,
            cdp_relay_opened,
            payload_marker_present,
            runc_state,
            cgroup_present: cgroup.as_ref().is_some_and(|path| path.is_dir()),
            job_directory_present,
            child_count: init_pid.map_or(0, observed_child_count),
            cleanup_failure: state.cleanup_failure,
        })
    }
}

fn configure_create_fds(
    command: &mut Command,
    bundle: BundleId,
    descriptors: &[OwnedFd],
) -> BrokerResult<()> {
    let expected = bundle.descriptor_roles();
    if descriptors.len() != expected.len() {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    command
        .stdin(Stdio::from(nix::unistd::dup(&descriptors[0]).map_err(
            |error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error),
        )?))
        .stdout(Stdio::from(nix::unistd::dup(&descriptors[1]).map_err(
            |error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error),
        )?))
        .stderr(Stdio::from(nix::unistd::dup(&descriptors[2]).map_err(
            |error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error),
        )?));
    let relay = (bundle != BundleId::CodexV1).then_some(descriptors[3].as_raw_fd());
    unsafe {
        command.pre_exec(move || {
            if let Some(relay) = relay
                && nix::libc::dup2(relay, 3) < 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let result = nix::libc::syscall(
                nix::libc::SYS_close_range,
                3_u32,
                u32::MAX,
                nix::libc::CLOSE_RANGE_CLOEXEC,
            );
            if result < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if relay.is_some() {
                let flags = nix::libc::fcntl(3, nix::libc::F_GETFD);
                if flags < 0
                    || nix::libc::fcntl(3, nix::libc::F_SETFD, flags & !nix::libc::FD_CLOEXEC) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(())
}

fn wait_child(
    child: &mut Child,
    deadline: Instant,
    cancelled: &AtomicBool,
    identity: Option<&ProcessIdentity>,
) -> BrokerResult<ExitStatus> {
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?
        {
            return Ok(status);
        }
        let init_exited = identity.is_some_and(ProcessIdentity::exited);
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline || init_exited {
            if init_exited {
                cancelled.store(true, Ordering::Release);
            }
            let _ = child.kill();
            let started = Instant::now();
            loop {
                if let Some(status) = child.try_wait().map_err(|error| {
                    BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
                })? {
                    let _ = status;
                    return Err(BrokerError::new(if init_exited {
                        ErrorCategory::SandboxUnavailable
                    } else {
                        ErrorCategory::DeadlineExceeded
                    }));
                }
                if started.elapsed() >= COMMAND_KILL_BOUND {
                    return Err(BrokerError::new(ErrorCategory::CleanupFailed));
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn run_output_bounded(
    mut command: Command,
    bound: Duration,
    category: ErrorCategory,
) -> BrokerResult<std::process::Output> {
    let mut child = command
        .spawn()
        .map_err(|error| BrokerError::with_source(category, error))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| BrokerError::new(category))?;
    let flags = unsafe { nix::libc::fcntl(stdout.as_raw_fd(), nix::libc::F_GETFL) };
    if flags < 0
        || unsafe {
            nix::libc::fcntl(
                stdout.as_raw_fd(),
                nix::libc::F_SETFL,
                flags | nix::libc::O_NONBLOCK,
            )
        } < 0
    {
        let _ = child.kill();
        let _ = reap_child_bounded(&mut child, bound);
        return Err(BrokerError::new(category));
    }
    let deadline = Instant::now() + bound;
    let mut output = Vec::new();
    let mut stdout_eof = false;
    let mut status = None;
    loop {
        loop {
            let mut buffer = [0_u8; 8192];
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    stdout_eof = true;
                    break;
                }
                Ok(count) => {
                    output.extend_from_slice(&buffer[..count]);
                    if output.len() > COMMAND_OUTPUT_BOUND {
                        let _ = child.kill();
                        let _ = reap_child_bounded(&mut child, bound);
                        return Err(BrokerError::new(category));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => {
                    let _ = child.kill();
                    let _ = reap_child_bounded(&mut child, bound);
                    return Err(BrokerError::with_source(category, error));
                }
            }
        }
        if status.is_none() {
            status = child
                .try_wait()
                .map_err(|error| BrokerError::with_source(category, error))?;
        }
        if let Some(status) = status
            && stdout_eof
        {
            return Ok(std::process::Output {
                status,
                stdout: output,
                stderr: Vec::new(),
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = reap_child_bounded(&mut child, bound);
            return Err(BrokerError::new(category));
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn reap_child_bounded(child: &mut Child, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if child.try_wait().ok().flatten().is_some() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn run_status_bounded(
    mut command: Command,
    bound: Duration,
    category: ErrorCategory,
) -> BrokerResult<ExitStatus> {
    let mut child = command
        .spawn()
        .map_err(|error| BrokerError::with_source(category, error))?;
    let deadline = Instant::now() + bound;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                if !reap_child_bounded(&mut child, bound) {
                    return Err(BrokerError::new(ErrorCategory::CleanupFailed));
                }
                return Err(BrokerError::new(category));
            }
            Err(error) => {
                let _ = child.kill();
                let reaped = reap_child_bounded(&mut child, bound);
                return Err(if reaped {
                    BrokerError::with_source(category, error)
                } else {
                    BrokerError::new(ErrorCategory::CleanupFailed)
                });
            }
        }
    }
}

fn receive_exact_pidfd(socket: i32) -> BrokerResult<OwnedFd> {
    let mut byte = [0_u8; 1];
    let mut iov = [std::io::IoSliceMut::new(&mut byte)];
    let mut control = cmsg_space!([i32; 2]);
    let message = recvmsg::<()>(
        socket,
        &mut iov,
        Some(&mut control),
        MsgFlags::MSG_CMSG_CLOEXEC,
    )
    .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if message
        .flags
        .intersects(MsgFlags::MSG_TRUNC | MsgFlags::MSG_CTRUNC)
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let mut descriptors = Vec::new();
    let mut unexpected = false;
    for item in message
        .cmsgs()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?
    {
        match item {
            ControlMessageOwned::ScmRights(raw) => descriptors.extend(
                raw.into_iter()
                    .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) }),
            ),
            _ => unexpected = true,
        }
    }
    if unexpected || descriptors.len() != 1 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    descriptors
        .pop()
        .ok_or_else(|| BrokerError::new(ErrorCategory::SandboxUnavailable))
}

fn pidfd_pid(fd: std::os::fd::BorrowedFd<'_>) -> BrokerResult<u32> {
    let contents = fs::read_to_string(format!("/proc/self/fdinfo/{}", fd.as_raw_fd()))
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let values = contents
        .lines()
        .filter_map(|line| line.strip_prefix("Pid:"))
        .map(str::trim)
        .collect::<Vec<_>>();
    if values.len() != 1
        || values[0].is_empty()
        || values[0].bytes().any(|byte| !byte.is_ascii_digit())
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let pid = values[0]
        .parse::<u32>()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if pid == 0 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(pid)
}

fn pidfd_live(fd: std::os::fd::BorrowedFd<'_>) -> bool {
    let mut pollfd = nix::libc::pollfd {
        fd: fd.as_raw_fd(),
        events: nix::libc::POLLIN,
        revents: 0,
    };
    let polled = unsafe { nix::libc::poll(&mut pollfd, 1, 0) };
    if polled != 0 || pollfd.revents != 0 {
        return false;
    }
    let result = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            0,
            std::ptr::null::<nix::libc::siginfo_t>(),
            0,
        )
    };
    result == 0
}

fn wait_pidfd_exit(identity: &ProcessIdentity, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if identity.exited() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn deadline_expired(deadline_unix_ms: u64) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now >= deadline_unix_ms as u128
}

fn deadline_allowed(deadline_unix_ms: u64) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now < u128::from(deadline_unix_ms)
        && u128::from(deadline_unix_ms) <= now + u128::from(MAX_JOB_WALL_TIME_MS)
}

fn monotonic_deadline(deadline_unix_ms: u64) -> BrokerResult<Instant> {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if now_unix >= u128::from(deadline_unix_ms)
        || u128::from(deadline_unix_ms) > now_unix + u128::from(MAX_JOB_WALL_TIME_MS)
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let remaining = u128::from(deadline_unix_ms) - now_unix;
    Ok(Instant::now() + Duration::from_millis(remaining as u64))
}

fn cancellation_outcome(job: &Job) -> Outcome {
    match lock(&job.state)
        .ok()
        .and_then(|state| state.cancellation_reason)
    {
        Some(CancelReason::TimedOut) => Outcome::TimedOut,
        Some(CancelReason::Cancelled | CancelReason::Shutdown) => Outcome::Cancelled,
        Some(CancelReason::AuthorizationFailed | CancelReason::ProtocolError) | None => {
            Outcome::Failed
        }
    }
}

fn unavailable_terminal_diagnostic(job: &Job) -> Diagnostic {
    Diagnostic {
        correlation_id: job.correlation_id,
        job_id: job.owner.job_id,
        phase: Phase::Terminal,
        init_pid: None,
        pidfd_live: false,
        pidfd_pid_matches: false,
        control_lease_connected: false,
        inert_relay_fd_present: false,
        relay_listener_present: false,
        cdp_relay_opened: false,
        payload_marker_present: false,
        runc_state: None,
        cgroup_present: false,
        job_directory_present: false,
        child_count: 0,
        cleanup_failure: true,
    }
}

fn fail_stop_diagnostic(job: &Job, phase: Phase) -> Diagnostic {
    Diagnostic {
        correlation_id: job.correlation_id,
        job_id: job.owner.job_id,
        phase,
        init_pid: None,
        pidfd_live: false,
        pidfd_pid_matches: false,
        control_lease_connected: false,
        inert_relay_fd_present: false,
        relay_listener_present: false,
        cdp_relay_opened: false,
        payload_marker_present: false,
        runc_state: None,
        cgroup_present: false,
        job_directory_present: true,
        child_count: 0,
        cleanup_failure: true,
    }
}

fn relay_fd_matches(pid: u32, expected: &OwnedFd) -> bool {
    let Ok(metadata) = nix::sys::stat::fstat(expected) else {
        return false;
    };
    let Ok(target) = fs::read_link(format!("/proc/{pid}/fd/3")) else {
        return false;
    };
    target.to_string_lossy() == format!("socket:[{}]", metadata.st_ino)
}

fn namespace_path_is_socket(pid: u32, relative: &str) -> bool {
    fs::symlink_metadata(format!("/proc/{pid}/root/{relative}"))
        .is_ok_and(|metadata| metadata.file_type().is_socket())
}

fn namespace_path_is_file(pid: u32, relative: &str) -> bool {
    fs::symlink_metadata(format!("/proc/{pid}/root/{relative}"))
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

fn observed_child_count(pid: u32) -> u32 {
    fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .map(|children| children.split_whitespace().count() as u32)
        .unwrap_or(0)
}

fn layout_for_existing(jobs_root: &Path, job_id: Uuid) -> JobLayout {
    let directory = jobs_root.join(job_id.to_string());
    let artifact_directory = directory.join("artifacts");
    JobLayout {
        job_id,
        bundle_id: BundleId::CodexV1,
        rootfs: PathBuf::from("/opt/firecrawl/sandbox-bundles/codex-v1/rootfs"),
        pid_file: directory.join("pid"),
        pidfd_socket: directory.join("pidfd.sock"),
        config_file: directory.join("config.json"),
        attestation_file: directory.join("acceptance.json"),
        artifact_directory: artifact_directory.exists().then_some(artifact_directory),
        directory,
    }
}

fn production_cgroup_path(job_id: Uuid) -> PathBuf {
    production_cgroup_root().join(format!("firecrawl-{job_id}"))
}

fn cleanup_production_cgroup(job_id: Uuid) -> BrokerResult<()> {
    cleanup_cgroup_at(&production_cgroup_root(), job_id)
}

fn cleanup_cgroup_at(root: &Path, job_id: Uuid) -> BrokerResult<()> {
    let path = root.join(format!("firecrawl-{job_id}"));
    if !path.exists() {
        return Ok(());
    }
    let kill = path.join("cgroup.kill");
    if kill.is_file() {
        fs::write(&kill, b"1\n")
            .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    }
    let deadline = Instant::now() + COMMAND_KILL_BOUND;
    loop {
        let events = path.join("cgroup.events");
        if events.is_file() {
            let contents = fs::read_to_string(&events)
                .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
            let populated = contents
                .lines()
                .find_map(|line| line.strip_prefix("populated "))
                .ok_or_else(|| BrokerError::new(ErrorCategory::CleanupFailed))?;
            if populated != "0" {
                if Instant::now() >= deadline {
                    return Err(BrokerError::new(ErrorCategory::CleanupFailed));
                }
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        }
        match fs::remove_dir(&path) {
            Ok(()) if !path.exists() => return Ok(()),
            Ok(()) => return Err(BrokerError::new(ErrorCategory::CleanupFailed)),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(code) if code == nix::libc::EBUSY || code == nix::libc::ENOTEMPTY
                ) && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                return Err(BrokerError::with_source(
                    ErrorCategory::CleanupFailed,
                    error,
                ));
            }
        }
    }
}

fn reconcile_production_cgroups() -> BrokerResult<()> {
    reconcile_cgroups_at(&production_cgroup_root())
}

fn production_cgroup_root() -> PathBuf {
    cgroup_host_path(PRODUCTION_CGROUPS_PATH)
}

fn production_service_cgroup_root() -> PathBuf {
    cgroup_host_path(PRODUCTION_SERVICE_CGROUP_PATH)
}

fn cgroup_host_path(path: &str) -> PathBuf {
    Path::new(CGROUP_FILESYSTEM_ROOT).join(
        path.strip_prefix('/')
            .expect("fixed production cgroup path is absolute"),
    )
}

fn prepare_production_cgroup_tree() -> BrokerResult<()> {
    let membership = fs::read("/proc/self/cgroup")
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    validate_broker_cgroup_membership(&membership)?;
    prepare_cgroup_tree_at(
        &production_service_cgroup_root(),
        &production_cgroup_root(),
        0,
    )
}

fn validate_broker_cgroup_membership(bytes: &[u8]) -> BrokerResult<()> {
    if bytes != format!("0::{PRODUCTION_BROKER_CGROUP_PATH}\n").as_bytes() {
        return Err(BrokerError::new(ErrorCategory::CleanupFailed));
    }
    Ok(())
}

fn prepare_cgroup_tree_at(
    service_root: &Path,
    jobs_root: &Path,
    required_uid: u32,
) -> BrokerResult<()> {
    validate_cgroup_directory(service_root, required_uid)?;
    enable_required_controllers(service_root)?;
    match fs::create_dir(jobs_root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(BrokerError::with_source(
                ErrorCategory::CleanupFailed,
                error,
            ));
        }
    }
    validate_cgroup_directory(jobs_root, required_uid)?;
    enable_required_controllers(jobs_root)
}

fn validate_cgroup_directory(path: &Path, required_uid: u32) -> BrokerResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != required_uid
        || metadata.mode() & 0o022 != 0
    {
        return Err(BrokerError::new(ErrorCategory::CleanupFailed));
    }
    Ok(())
}

fn enable_required_controllers(path: &Path) -> BrokerResult<()> {
    const REQUIRED: [&str; 4] = ["cpu", "io", "memory", "pids"];
    let controllers = fs::read_to_string(path.join("cgroup.controllers"))
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
    let available = controllers.split_ascii_whitespace().collect::<HashSet<_>>();
    if REQUIRED
        .iter()
        .any(|required| !available.iter().any(|actual| actual == required))
    {
        return Err(BrokerError::new(ErrorCategory::CleanupFailed));
    }
    fs::write(
        path.join("cgroup.subtree_control"),
        b"+cpu +io +memory +pids\n",
    )
    .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))
}

fn reconcile_cgroups_at(root: &Path) -> BrokerResult<()> {
    if !root.is_dir() {
        return Err(BrokerError::new(ErrorCategory::CleanupFailed));
    }
    for entry in fs::read_dir(root)
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?
    {
        let entry =
            entry.map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
        if !entry
            .file_type()
            .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?
            .is_dir()
        {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| BrokerError::new(ErrorCategory::CleanupFailed))?;
        let job_id = name
            .strip_prefix("firecrawl-")
            .ok_or_else(|| BrokerError::new(ErrorCategory::CleanupFailed))
            .and_then(|value| {
                Uuid::parse_str(value)
                    .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))
            })?;
        if name != format!("firecrawl-{job_id}") {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        cleanup_cgroup_at(root, job_id)?;
    }
    for entry in fs::read_dir(root)
        .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?
    {
        let entry =
            entry.map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?;
        if entry
            .file_type()
            .map_err(|error| BrokerError::with_source(ErrorCategory::CleanupFailed, error))?
            .is_dir()
        {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
    }
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> BrokerResult<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| BrokerError::new(ErrorCategory::SandboxUnavailable))
}

fn borrowed_validated(
    bundle: BundleId,
    descriptors: &[OwnedFd],
) -> BrokerResult<ValidatedDescriptors> {
    // Descriptors already passed the peer gate. Duplicate them only to reuse the
    // layout materializer without transferring lifecycle ownership.
    let duplicates = descriptors
        .iter()
        .map(|descriptor| {
            nix::unistd::dup(descriptor)
                .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))
        })
        .collect::<BrokerResult<Vec<_>>>()?;
    // UID/type/seal validation happened before registry admission.
    Ok(unsafe_validated(bundle, duplicates))
}

fn unsafe_validated(bundle: BundleId, descriptors: Vec<OwnedFd>) -> ValidatedDescriptors {
    // Kept module-private through this constructor boundary. The registry only
    // calls it for FDs already accepted by peer::validate_descriptors.
    crate::peer::validated_after_dup(bundle, descriptors)
}

#[cfg(test)]
mod fd_table_tests {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::thread;
    use std::time::Duration;

    use nix::fcntl::OFlag;
    use nix::sys::memfd::{MFdFlags, memfd_create};
    use nix::sys::socket::{AddressFamily, SockFlag, SockType, socketpair};
    use nix::unistd::pipe2;

    use super::{
        configure_create_fds, prepare_cgroup_tree_at, reconcile_cgroups_at, run_output_bounded,
        run_status_bounded, validate_broker_cgroup_membership,
    };
    use crate::oci::PRODUCTION_BROKER_CGROUP_PATH;
    use crate::protocol::BundleId;
    use crate::redaction::ErrorCategory;

    #[test]
    fn create_child_fd_table_is_stdio_only_for_codex_and_exact_relay_for_code() {
        let (stdin, _stdin_writer) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let (_stdout_reader, stdout) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let (_stderr_reader, stderr) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let auth = memfd_create("auth", MFdFlags::MFD_CLOEXEC).unwrap();
        let config = memfd_create("config", MFdFlags::MFD_CLOEXEC).unwrap();
        let mut command = Command::new("/usr/bin/sleep");
        command.arg("2");
        configure_create_fds(
            &mut command,
            BundleId::CodexV1,
            &[stdin, stdout, stderr, auth, config],
        )
        .unwrap();
        let mut child = command.spawn().unwrap();
        thread::sleep(Duration::from_millis(20));
        assert_eq!(fd_numbers(child.id()), vec![0, 1, 2]);
        child.kill().unwrap();
        child.wait().unwrap();

        let input = memfd_create("input", MFdFlags::MFD_CLOEXEC).unwrap();
        let (_stdout_reader, stdout) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let (_stderr_reader, stderr) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let (relay, _peer) = socketpair(
            AddressFamily::Unix,
            SockType::Stream,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let relay_inode = nix::sys::stat::fstat(&relay).unwrap().st_ino;
        let descriptors = vec![input, stdout, stderr, relay];
        let mut command = Command::new("/usr/bin/sleep");
        command.arg("2");
        configure_create_fds(&mut command, BundleId::CodeNodeV1, &descriptors).unwrap();
        let mut child = command.spawn().unwrap();
        thread::sleep(Duration::from_millis(20));
        assert_eq!(fd_numbers(child.id()), vec![0, 1, 2, 3]);
        assert_eq!(
            std::fs::read_link(format!("/proc/{}/fd/3", child.id()))
                .unwrap()
                .to_string_lossy(),
            format!("socket:[{relay_inode}]")
        );
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn cgroup_reconcile_rejects_noncanonical_names_and_leaves_no_child_dirs() {
        let root = tempfile::tempdir().unwrap();
        let job_id = uuid::Uuid::new_v4();
        let uppercase = root
            .path()
            .join(format!("firecrawl-{}", job_id.to_string().to_uppercase()));
        std::fs::create_dir(&uppercase).unwrap();
        assert!(reconcile_cgroups_at(root.path()).is_err());
        assert!(uppercase.exists());
        std::fs::remove_dir(&uppercase).unwrap();

        let canonical = root.path().join(format!("firecrawl-{job_id}"));
        std::fs::create_dir(&canonical).unwrap();
        reconcile_cgroups_at(root.path()).unwrap();
        assert!(!canonical.exists());
        assert!(
            std::fs::read_dir(root.path())
                .unwrap()
                .all(|entry| !entry.unwrap().path().is_dir())
        );
    }

    #[test]
    fn delegated_cgroup_tree_separates_broker_process_and_job_subtree() {
        let root = tempfile::tempdir().unwrap();
        let service = root.path().join("firecrawl-sandbox-broker.service");
        let jobs = service.join("jobs");
        std::fs::create_dir(&service).unwrap();
        std::fs::create_dir(&jobs).unwrap();
        for path in [&service, &jobs] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::write(
                path.join("cgroup.controllers"),
                b"cpuset cpu io memory hugetlb pids\n",
            )
            .unwrap();
            std::fs::write(path.join("cgroup.subtree_control"), b"").unwrap();
        }
        prepare_cgroup_tree_at(&service, &jobs, nix::unistd::geteuid().as_raw()).unwrap();
        for path in [&service, &jobs] {
            assert_eq!(
                std::fs::read(path.join("cgroup.subtree_control")).unwrap(),
                b"+cpu +io +memory +pids\n"
            );
        }
        let membership = format!("0::{PRODUCTION_BROKER_CGROUP_PATH}\n");
        validate_broker_cgroup_membership(membership.as_bytes()).unwrap();
        assert!(
            validate_broker_cgroup_membership(
                b"0::/system.slice/firecrawl-sandbox-broker.service\n"
            )
            .is_err()
        );
        assert!(!jobs.starts_with(service.join("broker")));
    }

    #[test]
    fn bounded_command_does_not_wait_for_descendant_held_stdout() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 2 &"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let started = std::time::Instant::now();
        assert!(
            run_output_bounded(
                command,
                Duration::from_millis(50),
                ErrorCategory::CleanupFailed,
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn bounded_status_runner_accepts_null_stdout_call_shape() {
        let mut command = Command::new("/usr/bin/true");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        assert!(
            run_status_bounded(
                command,
                Duration::from_millis(100),
                ErrorCategory::CleanupFailed,
            )
            .unwrap()
            .success()
        );
    }

    fn fd_numbers(pid: u32) -> Vec<u32> {
        let mut fds = std::fs::read_dir(format!("/proc/{pid}/fd"))
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .parse::<u32>()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        fds.sort_unstable();
        fds
    }
}
