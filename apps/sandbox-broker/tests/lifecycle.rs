use std::collections::HashMap;
use std::fs;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use firecrawl_sandbox_broker::bundles::{BundlePolicy, FIXED_CODEX_CONFIG};
use firecrawl_sandbox_broker::oci::{JobLayout, RuncStateRecord, create_job_layout};
use firecrawl_sandbox_broker::peer::{ValidatedDescriptors, validate_descriptors};
use firecrawl_sandbox_broker::protocol::{
    BrokerResponse, BundleId, CancelReason, Outcome, Phase, RuncState,
};
use firecrawl_sandbox_broker::redaction::{BrokerError, BrokerResult, ErrorCategory};
use firecrawl_sandbox_broker::registry::{BrokerRuntime, ProcessIdentity, RealRunc, Runc};
use nix::fcntl::{FcntlArg, OFlag, SealFlag, fcntl};
use nix::sys::memfd::{MFdFlags, memfd_create};
use nix::sys::signal::Signal;
use nix::sys::socket::{AddressFamily, SockFlag, SockType, socketpair};
use nix::unistd::{Pid, pipe2, write};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

struct FakeRunc {
    states: Mutex<HashMap<Uuid, RuncStateRecord>>,
    children: Mutex<HashMap<Uuid, Child>>,
    events: Mutex<Vec<String>>,
    marker: std::path::PathBuf,
    hang_create: AtomicBool,
    fail_create_cleanup: AtomicBool,
    hang_start: AtomicBool,
    fail_start_reap: AtomicBool,
    fail_start: AtomicBool,
    mismatch_state_pid: AtomicBool,
    fail_state: AtomicBool,
    fail_delete: AtomicBool,
    network_delay_ms: AtomicU64,
}

impl FakeRunc {
    fn new(marker: std::path::PathBuf) -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            events: Mutex::new(Vec::new()),
            marker,
            hang_create: AtomicBool::new(false),
            fail_create_cleanup: AtomicBool::new(false),
            hang_start: AtomicBool::new(false),
            fail_start_reap: AtomicBool::new(false),
            fail_start: AtomicBool::new(false),
            mismatch_state_pid: AtomicBool::new(false),
            fail_state: AtomicBool::new(false),
            fail_delete: AtomicBool::new(false),
            network_delay_ms: AtomicU64::new(0),
        }
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn record(&self, event: &str) {
        self.events.lock().unwrap().push(event.to_owned());
    }
}

impl Drop for FakeRunc {
    fn drop(&mut self) {
        for child in self.children.get_mut().unwrap().values_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Runc for FakeRunc {
    fn create(
        &self,
        layout: &JobLayout,
        _bundle: BundleId,
        _descriptors: &[OwnedFd],
        deadline: Instant,
        cancelled: &AtomicBool,
    ) -> BrokerResult<ProcessIdentity> {
        self.record("create");
        if self.fail_create_cleanup.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        while self.hang_create.load(Ordering::Acquire) {
            if cancelled.load(Ordering::Acquire) {
                return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
            }
            if Instant::now() >= deadline {
                return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
            }
            thread::sleep(Duration::from_millis(2));
        }
        let child = Command::new("/usr/bin/sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        fs::write(&layout.pid_file, format!("{pid}\n")).unwrap();
        fs::set_permissions(&layout.pid_file, fs::Permissions::from_mode(0o600)).unwrap();
        self.children.lock().unwrap().insert(layout.job_id, child);
        self.states.lock().unwrap().insert(
            layout.job_id,
            RuncStateRecord {
                oci_version: "1.2.0".to_owned(),
                id: layout.job_id.to_string(),
                pid: i64::from(pid) + i64::from(self.mismatch_state_pid.load(Ordering::Acquire)),
                status: RuncState::Created,
                bundle: layout.directory.to_string_lossy().into_owned(),
                rootfs: "/opt/firecrawl/sandbox-bundles/codex-v1/rootfs".to_owned(),
                created: "2026-07-27T00:00:00Z".to_owned(),
                annotations: std::collections::BTreeMap::new(),
                owner: String::new(),
            },
        );
        ProcessIdentity::open_for_test(pid)
    }

    fn state(&self, layout: &JobLayout) -> BrokerResult<Option<RuncStateRecord>> {
        self.record("state");
        if self.fail_state.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        Ok(self.states.lock().unwrap().get(&layout.job_id).cloned())
    }

    fn configure_created_network(
        &self,
        _layout: &JobLayout,
        bundle: BundleId,
        _identity: &ProcessIdentity,
    ) -> BrokerResult<()> {
        let delay = self.network_delay_ms.load(Ordering::Acquire);
        if delay != 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        if bundle != BundleId::CodexV1 {
            self.record("loopback-up");
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
        self.record("start");
        while self.hang_start.load(Ordering::Acquire) {
            if cancelled.load(Ordering::Acquire) {
                return Err(BrokerError::new(
                    if self.fail_start_reap.load(Ordering::Acquire) {
                        ErrorCategory::CleanupFailed
                    } else {
                        ErrorCategory::DeadlineExceeded
                    },
                ));
            }
            if identity.exited() {
                return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
            }
            if Instant::now() >= deadline {
                return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
            }
            thread::sleep(Duration::from_millis(2));
        }
        if self.fail_start.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::Conflict));
        }
        identity.validate()?;
        fs::write(&self.marker, b"marker\n").unwrap();
        if let Some(root) = &layout.artifact_directory {
            let files = root.join("files");
            fs::create_dir(&files).unwrap();
            let contents = b"\x89PNG\r\n\x1a\nartifact";
            fs::write(files.join("result.png"), contents).unwrap();
            let checksum = Sha256::digest(contents)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            fs::write(
                root.join("manifest.json"),
                serde_json::to_vec(&serde_json::json!([{
                    "artifactId":Uuid::new_v4(),
                    "name":"result.png",
                    "kind":"screenshot",
                    "contentType":"image/png",
                    "byteSize":contents.len(),
                    "checksum":checksum
                }]))
                .unwrap(),
            )
            .unwrap();
        }
        self.states
            .lock()
            .unwrap()
            .get_mut(&layout.job_id)
            .unwrap()
            .status = RuncState::Running;
        Ok(())
    }

    fn kill(&self, layout: &JobLayout, signal: Signal) -> BrokerResult<()> {
        self.record(match signal {
            Signal::SIGTERM => "kill-term",
            Signal::SIGKILL => "kill-kill",
            _ => "kill-other",
        });
        let children = self.children.lock().unwrap();
        if let Some(child) = children.get(&layout.job_id) {
            let _ = nix::sys::signal::kill(Pid::from_raw(child.id() as i32), signal);
        }
        Ok(())
    }

    fn delete_force(&self, layout: &JobLayout) -> BrokerResult<()> {
        self.record("delete");
        if self.fail_delete.load(Ordering::Acquire) {
            return Err(BrokerError::new(ErrorCategory::CleanupFailed));
        }
        if let Some(mut child) = self.children.lock().unwrap().remove(&layout.job_id) {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.states.lock().unwrap().remove(&layout.job_id);
        Ok(())
    }

    fn list(&self, _runtime_root: &std::path::Path) -> BrokerResult<Vec<Uuid>> {
        Ok(self.states.lock().unwrap().keys().copied().collect())
    }
}

#[test]
fn prepare_stops_at_created_then_same_lease_start_runs_once() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let correlation_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, job_id, correlation_id);
    assert!(!fixture.marker.exists());
    assert!(
        fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .join("acceptance.json")
            .is_file()
    );
    let diagnostic = fixture
        .runtime
        .diagnose(fixture.uid, correlation_id, job_id)
        .unwrap();
    assert_eq!(diagnostic.phase, Phase::Prepared);
    assert_eq!(diagnostic.runc_state, Some(RuncState::Created));
    assert!(diagnostic.pidfd_live);
    assert!(!diagnostic.inert_relay_fd_present);
    assert!(!diagnostic.relay_listener_present);
    assert!(!diagnostic.cdp_relay_opened);
    assert!(!diagnostic.payload_marker_present);

    let started = fixture
        .runtime
        .start(fixture.uid, &lease, lease.init_pid())
        .unwrap();
    assert_eq!(
        started,
        BrokerResponse::Started {
            job_id,
            init_pid: lease.init_pid()
        }
    );
    assert_eq!(fs::read(&fixture.marker).unwrap(), b"marker\n");
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .join("acceptance.json")
            .exists()
    );
    let terminal = fixture
        .runtime
        .cancel(fixture.uid, &lease, boot_id, CancelReason::Cancelled)
        .unwrap();
    assert_eq!(
        terminal,
        BrokerResponse::Terminal {
            job_id,
            init_pid: lease.init_pid(),
            outcome: Outcome::Cancelled,
            artifacts: Vec::new()
        }
    );
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
    assert_eq!(
        fixture
            .runc
            .events()
            .iter()
            .filter(|event| event.as_str() == "start")
            .count(),
        1
    );
}

#[test]
fn abort_and_wrong_pid_never_start_payload_and_remove_all_state() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, job_id, Uuid::new_v4());
    assert!(
        fixture
            .runtime
            .start(fixture.uid, &lease, lease.init_pid() + 1)
            .is_err()
    );
    fixture.runtime.connection_eof(fixture.uid, &lease).unwrap();
    assert!(!fixture.marker.exists());
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
    assert!(!fixture.runc.events().contains(&"start".to_owned()));

    let second_id = Uuid::new_v4();
    let second = fixture.prepare(boot_id, second_id, Uuid::new_v4());
    assert_eq!(
        fixture
            .runtime
            .abort(fixture.uid, &second, CancelReason::AuthorizationFailed)
            .unwrap(),
        BrokerResponse::Aborted { job_id: second_id }
    );
    assert!(!fixture.marker.exists());
}

#[test]
fn exact_uid_boot_and_high_entropy_diagnostic_pair_are_fenced() {
    let fixture = Fixture::new();
    let boot_a = Uuid::new_v4();
    let boot_b = Uuid::new_v4();
    let job_a = Uuid::new_v4();
    let job_b = Uuid::new_v4();
    let correlation_a = Uuid::new_v4();
    let correlation_b = Uuid::new_v4();
    let lease_a = fixture.prepare(boot_a, job_a, correlation_a);
    let lease_b = fixture.prepare(boot_b, job_b, correlation_b);
    assert!(
        fixture
            .runtime
            .start(fixture.uid + 1, &lease_a, lease_a.init_pid())
            .is_err()
    );
    assert!(
        fixture
            .runtime
            .diagnose(fixture.uid, Uuid::new_v4(), job_a)
            .is_err()
    );
    fixture.runtime.cancel_owner(fixture.uid, boot_a).unwrap();
    assert!(
        fixture
            .runtime
            .diagnose(fixture.uid, correlation_a, job_a)
            .is_ok()
    );
    assert!(
        fixture
            .runtime
            .diagnose(fixture.uid, correlation_b, job_b)
            .is_ok()
    );
    fixture
        .runtime
        .abort(fixture.uid, &lease_b, CancelReason::Shutdown)
        .unwrap();
}

#[test]
fn cancellation_wins_against_hung_start_without_started_or_marker() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, job_id, Uuid::new_v4());
    fixture.runc.hang_start.store(true, Ordering::Release);
    let runtime = Arc::clone(&fixture.runtime);
    let start_lease = lease.clone();
    let uid = fixture.uid;
    let start = thread::spawn(move || runtime.start(uid, &start_lease, start_lease.init_pid()));
    thread::sleep(Duration::from_millis(20));
    let terminal = fixture
        .runtime
        .cancel(fixture.uid, &lease, boot_id, CancelReason::Cancelled)
        .unwrap();
    assert!(start.join().unwrap().is_err());
    assert!(matches!(
        terminal,
        BrokerResponse::Terminal {
            outcome: Outcome::Cancelled,
            ..
        }
    ));
    assert!(!fixture.marker.exists());
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
}

#[test]
fn unreaped_start_cli_failure_poison_health_without_concurrent_cleanup() {
    let fixture = Fixture::new();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(Uuid::new_v4(), job_id, Uuid::new_v4());
    let other_job_id = Uuid::new_v4();
    let other_lease = fixture.prepare(Uuid::new_v4(), other_job_id, Uuid::new_v4());
    fixture.runc.hang_start.store(true, Ordering::Release);
    fixture.runc.fail_start_reap.store(true, Ordering::Release);
    let runtime = Arc::clone(&fixture.runtime);
    let uid = fixture.uid;
    let thread_lease = lease.clone();
    let start = thread::spawn(move || runtime.start(uid, &thread_lease, thread_lease.init_pid()));
    while !fixture.runc.events().iter().any(|event| event == "start") {
        thread::sleep(Duration::from_millis(2));
    }
    fixture
        .runtime
        .request_cancel_lease(fixture.uid, &lease, CancelReason::ProtocolError)
        .unwrap();
    let error = start.join().unwrap().unwrap_err();
    assert_eq!(error.category(), ErrorCategory::CleanupFailed);
    assert!(!fixture.runtime.is_healthy());
    assert!(!fixture.runc.events().iter().any(|event| event == "delete"));
    assert!(fixture.runc.states.lock().unwrap().contains_key(&job_id));
    let state_calls = fixture
        .runc
        .events()
        .iter()
        .filter(|event| event.as_str() == "state")
        .count();
    let diagnostic = fixture
        .runtime
        .diagnose(fixture.uid, lease.correlation_id(), job_id)
        .unwrap();
    assert!(diagnostic.cleanup_failure);
    assert_eq!(
        fixture
            .runc
            .events()
            .iter()
            .filter(|event| event.as_str() == "state")
            .count(),
        state_calls
    );
    assert!(fixture.runtime.connection_eof(fixture.uid, &lease).is_err());
    assert_eq!(
        fixture
            .runc
            .events()
            .iter()
            .filter(|event| event.as_str() == "state")
            .count(),
        state_calls
    );
    fixture
        .runtime
        .connection_eof(fixture.uid, &other_lease)
        .unwrap();
    assert!(
        !fixture
            .runc
            .states
            .lock()
            .unwrap()
            .contains_key(&other_job_id)
    );
    assert!(fixture.runc.states.lock().unwrap().contains_key(&job_id));
}

#[test]
fn cleanup_residue_is_fail_stop_for_health_and_admission() {
    let fixture = Fixture::new();
    let lease = fixture.prepare(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    fixture.runc.fail_delete.store(true, Ordering::Release);
    assert!(
        fixture
            .runtime
            .abort(fixture.uid, &lease, CancelReason::Cancelled)
            .is_err()
    );
    assert!(!fixture.runtime.is_healthy());
    assert!(
        fixture
            .runtime
            .prepare(
                fixture.uid,
                Uuid::new_v4(),
                Uuid::new_v4(),
                Uuid::new_v4(),
                BundleId::CodexV1,
                deadline(),
                codex_descriptors(fixture.uid),
            )
            .is_err()
    );
}

#[test]
fn prepare_cleanup_failure_poison_and_layout_setup_rolls_back() {
    let fixture = Fixture::new();
    fixture
        .runc
        .fail_create_cleanup
        .store(true, Ordering::Release);
    let job_id = Uuid::new_v4();
    let error = fixture
        .runtime
        .prepare(
            fixture.uid,
            Uuid::new_v4(),
            job_id,
            Uuid::new_v4(),
            BundleId::CodexV1,
            deadline(),
            codex_descriptors(fixture.uid),
        )
        .unwrap_err();
    assert_eq!(error.category(), ErrorCategory::CleanupFailed);
    assert!(!fixture.runtime.is_healthy());
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );

    let root = secure_temp();
    let job_id = Uuid::new_v4();
    let policy = BundlePolicy::load(BundleId::CodexV1).unwrap();
    assert!(
        create_job_layout(root.path(), job_id, &policy, &code_descriptors(fixture.uid),).is_err()
    );
    assert!(!root.path().join("jobs").join(job_id.to_string()).exists());
}

#[test]
fn cleanup_state_failure_still_force_deletes_exact_owned_container() {
    let fixture = Fixture::new();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(Uuid::new_v4(), job_id, Uuid::new_v4());
    fixture.runc.fail_state.store(true, Ordering::Release);
    assert!(
        fixture
            .runtime
            .abort(fixture.uid, &lease, CancelReason::Cancelled)
            .is_err()
    );
    assert!(fixture.runc.events().contains(&"delete".to_owned()));
    assert!(!fixture.runc.states.lock().unwrap().contains_key(&job_id));
    assert!(!fixture.runtime.is_healthy());
}

#[test]
fn hung_create_eof_deadline_and_pid_mismatch_never_publish_prepared() {
    let fixture = Fixture::new();
    fixture.runc.hang_create.store(true, Ordering::Release);
    let uid = fixture.uid;
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let correlation_id = Uuid::new_v4();
    let runtime = Arc::clone(&fixture.runtime);
    let prepare = thread::spawn(move || {
        runtime.prepare(
            uid,
            boot_id,
            job_id,
            correlation_id,
            BundleId::CodexV1,
            deadline(),
            codex_descriptors(uid),
        )
    });
    while !fixture.runc.events().contains(&"create".to_owned()) {
        thread::sleep(Duration::from_millis(2));
    }
    fixture
        .runtime
        .request_cancel_key(uid, boot_id, job_id, CancelReason::ProtocolError)
        .unwrap();
    assert!(prepare.join().unwrap().is_err());
    assert!(!fixture.marker.exists());
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );

    let deadline_fixture = Fixture::new();
    deadline_fixture
        .runc
        .hang_create
        .store(true, Ordering::Release);
    assert!(
        deadline_fixture
            .runtime
            .prepare(
                deadline_fixture.uid,
                Uuid::new_v4(),
                Uuid::new_v4(),
                Uuid::new_v4(),
                BundleId::CodexV1,
                now_ms() + 20,
                codex_descriptors(deadline_fixture.uid),
            )
            .is_err()
    );
    assert!(!deadline_fixture.marker.exists());

    let mismatch = Fixture::new();
    mismatch
        .runc
        .mismatch_state_pid
        .store(true, Ordering::Release);
    assert!(
        mismatch
            .runtime
            .prepare(
                mismatch.uid,
                Uuid::new_v4(),
                Uuid::new_v4(),
                Uuid::new_v4(),
                BundleId::CodexV1,
                deadline(),
                codex_descriptors(mismatch.uid),
            )
            .is_err()
    );
    assert!(!mismatch.marker.exists());
}

#[test]
fn diagnose_during_prepare_cannot_deadlock_descriptor_and_layout_locks() {
    let fixture = Fixture::new();
    fixture.runc.hang_create.store(true, Ordering::Release);
    let uid = fixture.uid;
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let correlation_id = Uuid::new_v4();
    let runtime = Arc::clone(&fixture.runtime);
    let prepare = thread::spawn(move || {
        runtime.prepare(
            uid,
            boot_id,
            job_id,
            correlation_id,
            BundleId::CodexV1,
            deadline(),
            codex_descriptors(uid),
        )
    });
    while !fixture.runc.events().contains(&"create".to_owned()) {
        thread::sleep(Duration::from_millis(2));
    }
    let runtime = Arc::clone(&fixture.runtime);
    let (sent, received) = std::sync::mpsc::channel();
    let diagnose = thread::spawn(move || {
        let _ = sent.send(runtime.diagnose(uid, correlation_id, job_id));
    });
    fixture
        .runtime
        .request_cancel_key(uid, boot_id, job_id, CancelReason::ProtocolError)
        .unwrap();
    assert!(prepare.join().unwrap().is_err());
    assert!(
        received.recv_timeout(Duration::from_secs(1)).is_ok(),
        "Prepare/Diagnose lock order deadlocked"
    );
    diagnose.join().unwrap();
}

#[test]
fn duplicate_start_start_failure_running_eof_and_job_reuse_fail_closed() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, job_id, Uuid::new_v4());
    fixture.runc.fail_start.store(true, Ordering::Release);
    assert!(
        fixture
            .runtime
            .start(fixture.uid, &lease, lease.init_pid())
            .is_err()
    );
    assert!(!fixture.marker.exists());
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );

    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, job_id, Uuid::new_v4());
    fixture.runc.fail_start.store(false, Ordering::Release);
    fixture
        .runtime
        .start(fixture.uid, &lease, lease.init_pid())
        .unwrap();
    assert!(
        fixture
            .runtime
            .start(fixture.uid, &lease, lease.init_pid())
            .is_err()
    );
    fixture.runtime.connection_eof(fixture.uid, &lease).unwrap();
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
    assert!(
        fixture
            .runtime
            .prepare(
                fixture.uid,
                boot_id,
                job_id,
                Uuid::new_v4(),
                BundleId::CodexV1,
                deadline(),
                codex_descriptors(fixture.uid),
            )
            .is_err()
    );
}

#[test]
fn real_runc_command_root_is_fixed_and_orphan_reconcile_is_non_resuming() {
    let temp = secure_temp();
    let fake = Arc::new(FakeRunc::new(temp.path().join("marker")));
    let orphan_id = Uuid::new_v4();
    let orphan_directory = temp.path().join("jobs").join(orphan_id.to_string());
    fs::create_dir_all(&orphan_directory).unwrap();
    let job_only_id = Uuid::new_v4();
    let job_only_directory = temp.path().join("jobs").join(job_only_id.to_string());
    fs::create_dir_all(job_only_directory.join("artifacts")).unwrap();
    fs::write(
        job_only_directory.join("artifacts").join("crash-residue"),
        b"residue",
    )
    .unwrap();
    let child = Command::new("/usr/bin/sleep").arg("60").spawn().unwrap();
    let pid = child.id();
    fake.children.lock().unwrap().insert(orphan_id, child);
    fake.states.lock().unwrap().insert(
        orphan_id,
        RuncStateRecord {
            oci_version: "1.2.0".to_owned(),
            id: orphan_id.to_string(),
            pid: i64::from(pid),
            status: RuncState::Running,
            bundle: orphan_directory.to_string_lossy().into_owned(),
            rootfs: "/opt/firecrawl/sandbox-bundles/codex-v1/rootfs".to_owned(),
            created: "2026-07-27T00:00:00Z".to_owned(),
            annotations: std::collections::BTreeMap::new(),
            owner: String::new(),
        },
    );
    let runtime = BrokerRuntime::new(temp.path().to_path_buf(), Arc::clone(&fake));
    runtime.reconcile_orphans().unwrap();
    assert!(runtime.is_healthy());
    assert!(!orphan_directory.exists());
    assert!(!job_only_directory.exists());
    assert!(!fake.events().contains(&"start".to_owned()));
    assert!(fake.states.lock().unwrap().is_empty());
    let _real = RealRunc::new(temp.path().to_path_buf());
}

#[test]
fn code_prepare_configures_loopback_before_authorization_without_payload() {
    let fixture = Fixture::new();
    let job_id = Uuid::new_v4();
    let lease = fixture
        .runtime
        .prepare(
            fixture.uid,
            Uuid::new_v4(),
            job_id,
            Uuid::new_v4(),
            BundleId::CodeNodeV1,
            deadline(),
            code_descriptors(fixture.uid),
        )
        .unwrap();
    let events = fixture.runc.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.as_str() == "loopback-up")
            .count(),
        1
    );
    assert!(!events.contains(&"start".to_owned()));
    assert!(!fixture.marker.exists());
    fixture
        .runtime
        .abort(fixture.uid, &lease, CancelReason::AuthorizationFailed)
        .unwrap();
}

#[test]
fn successful_code_finish_returns_validated_artifacts_and_completed() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let lease = fixture
        .runtime
        .prepare(
            fixture.uid,
            boot_id,
            job_id,
            Uuid::new_v4(),
            BundleId::CodeNodeV1,
            deadline(),
            code_descriptors(fixture.uid),
        )
        .unwrap();
    fixture
        .runtime
        .start(fixture.uid, &lease, lease.init_pid())
        .unwrap();
    let (terminal, artifacts) = fixture
        .runtime
        .finish(fixture.uid, &lease, boot_id, CancelReason::Shutdown)
        .unwrap();
    assert!(matches!(
        terminal,
        BrokerResponse::Terminal {
            outcome: Outcome::Completed,
            ref artifacts,
            ..
        } if artifacts.len() == 1
    ));
    assert_eq!(artifacts.len(), 1);
    let duplicate = nix::unistd::dup(&artifacts[0].descriptor).unwrap();
    let mut file = std::fs::File::from(duplicate);
    let mut contents = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut contents).unwrap();
    assert_eq!(contents, b"\x89PNG\r\n\x1a\nartifact");
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
}

#[test]
fn running_init_death_is_detected_by_retained_pidfd_and_cleaned() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, job_id, Uuid::new_v4());
    fixture
        .runtime
        .start(fixture.uid, &lease, lease.init_pid())
        .unwrap();
    let pidfd = fixture.runtime.monitor_pidfd(fixture.uid, &lease).unwrap();
    {
        let mut children = fixture.runc.children.lock().unwrap();
        let child = children.get_mut(&job_id).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }
    let mut pollfd = nix::libc::pollfd {
        fd: std::os::fd::AsRawFd::as_raw_fd(&pidfd),
        events: nix::libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { nix::libc::poll(&mut pollfd, 1, 1000) }, 1);
    let terminal = fixture.runtime.init_died(fixture.uid, &lease).unwrap();
    assert!(matches!(
        terminal,
        BrokerResponse::Terminal {
            outcome: Outcome::Failed,
            ..
        }
    ));
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
}

#[test]
fn stopped_state_with_zero_pid_is_deleted_without_poisoning_health() {
    let fixture = Fixture::new();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(Uuid::new_v4(), job_id, Uuid::new_v4());
    {
        let mut children = fixture.runc.children.lock().unwrap();
        let child = children.get_mut(&job_id).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }
    {
        let mut states = fixture.runc.states.lock().unwrap();
        let state = states.get_mut(&job_id).unwrap();
        state.status = RuncState::Stopped;
        state.pid = 0;
    }
    fixture.runtime.connection_eof(fixture.uid, &lease).unwrap();
    assert!(fixture.runtime.is_healthy());
    assert!(!fixture.runc.states.lock().unwrap().contains_key(&job_id));
}

#[test]
fn prepared_init_death_cannot_be_replaced_or_started() {
    let fixture = Fixture::new();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(Uuid::new_v4(), job_id, Uuid::new_v4());
    {
        let mut children = fixture.runc.children.lock().unwrap();
        let child = children.get_mut(&job_id).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(
        fixture
            .runtime
            .start(fixture.uid, &lease, lease.init_pid())
            .is_err()
    );
    let terminal = fixture.runtime.init_died(fixture.uid, &lease).unwrap();
    assert!(matches!(
        terminal,
        BrokerResponse::Terminal {
            outcome: Outcome::Failed,
            ..
        }
    ));
    assert!(!fixture.runc.events().contains(&"start".to_owned()));
}

#[test]
fn starting_init_death_interrupts_hung_start_without_waiting_for_deadline() {
    let fixture = Fixture::new();
    let job_id = Uuid::new_v4();
    let lease = fixture.prepare(Uuid::new_v4(), job_id, Uuid::new_v4());
    fixture.runc.hang_start.store(true, Ordering::Release);
    let runtime = Arc::clone(&fixture.runtime);
    let uid = fixture.uid;
    let thread_lease = lease.clone();
    let (sent, received) = std::sync::mpsc::channel();
    let start = thread::spawn(move || {
        let result = runtime.start(uid, &thread_lease, thread_lease.init_pid());
        let _ = sent.send(result);
    });
    while !fixture.runc.events().iter().any(|event| event == "start") {
        thread::sleep(Duration::from_millis(2));
    }
    {
        let mut children = fixture.runc.children.lock().unwrap();
        let child = children.get_mut(&job_id).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
    }
    let result = match received.recv_timeout(Duration::from_millis(500)) {
        Ok(result) => result,
        Err(error) => {
            fixture.runc.hang_start.store(false, Ordering::Release);
            let _ = fixture.runtime.request_cancel_lease(
                fixture.uid,
                &lease,
                CancelReason::ProtocolError,
            );
            let _ = start.join();
            panic!("hung start ignored init pidfd exit: {error}");
        }
    };
    assert!(result.is_err());
    start.join().unwrap();
    assert!(
        !fixture
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );
}

#[test]
fn network_and_start_deadlines_cannot_publish_or_run_late() {
    let network = Fixture::new();
    network.runc.network_delay_ms.store(40, Ordering::Release);
    let job_id = Uuid::new_v4();
    assert!(
        network
            .runtime
            .prepare(
                network.uid,
                Uuid::new_v4(),
                job_id,
                Uuid::new_v4(),
                BundleId::CodeNodeV1,
                now_ms() + 20,
                code_descriptors(network.uid),
            )
            .is_err()
    );
    assert!(
        !network
            .root
            .path()
            .join("jobs")
            .join(job_id.to_string())
            .exists()
    );

    let start = Fixture::new();
    let lease = start
        .runtime
        .prepare(
            start.uid,
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            BundleId::CodexV1,
            now_ms() + 100,
            codex_descriptors(start.uid),
        )
        .unwrap();
    start.runc.hang_start.store(true, Ordering::Release);
    assert!(
        start
            .runtime
            .start(start.uid, &lease, lease.init_pid())
            .is_err()
    );
    assert!(!start.marker.exists());
}

#[test]
fn cancelled_owner_boot_is_revoked_before_and_after_existing_cleanup() {
    let fixture = Fixture::new();
    let boot_id = Uuid::new_v4();
    let lease = fixture.prepare(boot_id, Uuid::new_v4(), Uuid::new_v4());
    fixture.runtime.cancel_owner(fixture.uid, boot_id).unwrap();
    assert!(
        fixture
            .runtime
            .prepare(
                fixture.uid,
                boot_id,
                Uuid::new_v4(),
                Uuid::new_v4(),
                BundleId::CodexV1,
                deadline(),
                codex_descriptors(fixture.uid),
            )
            .is_err()
    );
    assert!(
        fixture
            .runtime
            .start(fixture.uid, &lease, lease.init_pid())
            .is_err()
    );

    let never_seen = Uuid::new_v4();
    fixture
        .runtime
        .cancel_owner(fixture.uid, never_seen)
        .unwrap();
    assert!(
        fixture
            .runtime
            .prepare(
                fixture.uid,
                never_seen,
                Uuid::new_v4(),
                Uuid::new_v4(),
                BundleId::CodexV1,
                deadline(),
                codex_descriptors(fixture.uid),
            )
            .is_err()
    );
}

struct Fixture {
    root: TempDir,
    marker: std::path::PathBuf,
    runc: Arc<FakeRunc>,
    runtime: Arc<BrokerRuntime<FakeRunc>>,
    uid: u32,
}

impl Fixture {
    fn new() -> Self {
        let root = secure_temp();
        let marker = root.path().join("payload-marker");
        let runc = Arc::new(FakeRunc::new(marker.clone()));
        let runtime = Arc::new(BrokerRuntime::new(
            root.path().to_path_buf(),
            Arc::clone(&runc),
        ));
        Self {
            root,
            marker,
            runc,
            runtime,
            uid: nix::unistd::geteuid().as_raw(),
        }
    }

    fn prepare(
        &self,
        boot_id: Uuid,
        job_id: Uuid,
        correlation_id: Uuid,
    ) -> firecrawl_sandbox_broker::registry::PreparedLease {
        self.runtime
            .prepare(
                self.uid,
                boot_id,
                job_id,
                correlation_id,
                BundleId::CodexV1,
                deadline(),
                codex_descriptors(self.uid),
            )
            .unwrap()
    }
}

fn codex_descriptors(uid: u32) -> ValidatedDescriptors {
    let (stdin_read, _stdin_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    validate_descriptors(
        BundleId::CodexV1,
        uid,
        vec![
            stdin_read,
            stdout_write,
            stderr_write,
            sealed("auth", b"{}"),
            sealed("config", FIXED_CODEX_CONFIG.as_bytes()),
        ],
    )
    .unwrap()
}

fn code_descriptors(uid: u32) -> ValidatedDescriptors {
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (relay, _adapter_relay) = socketpair(
        AddressFamily::Unix,
        SockType::Stream,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .unwrap();
    validate_descriptors(
        BundleId::CodeNodeV1,
        uid,
        vec![
            sealed("input", b"console.log('ok')"),
            stdout_write,
            stderr_write,
            relay,
        ],
    )
    .unwrap()
}

fn sealed(name: &str, bytes: &[u8]) -> OwnedFd {
    let descriptor =
        memfd_create(name, MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING).unwrap();
    write(&descriptor, bytes).unwrap();
    fcntl(
        &descriptor,
        FcntlArg::F_ADD_SEALS(
            SealFlag::F_SEAL_WRITE
                | SealFlag::F_SEAL_GROW
                | SealFlag::F_SEAL_SHRINK
                | SealFlag::F_SEAL_SEAL,
        ),
    )
    .unwrap();
    descriptor
}

fn deadline() -> u64 {
    now_ms() + 60_000
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn secure_temp() -> TempDir {
    assert!(std::path::Path::new("/usr/bin/sleep").is_file());
    let temp = tempfile::tempdir().unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    temp
}
