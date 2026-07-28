use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use firecrawl_sandbox_broker::bundles::BundlePolicy;
use firecrawl_sandbox_broker::peer::{
    accept_peer_or_root, receive_packet, reject_descriptors, send_response,
    send_response_with_descriptors, set_timeout, validate_descriptors, validate_listener,
};
use firecrawl_sandbox_broker::protocol::{
    BrokerRequest, BrokerResponse, BundleId, CancelReason, PreparedControl, encode_response,
    parse_control, parse_request, validate_request, validate_shared_contract,
};
use firecrawl_sandbox_broker::redaction::{BrokerError, BrokerResult, ErrorCategory};
use firecrawl_sandbox_broker::registry::{BrokerRuntime, PreparedLease, RealRunc, Runc};
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::sys::socket::{MsgFlags, recv};
const RUNTIME_ROOT: &str = "/run/firecrawl-sandbox";
const BROKER_SOCKET_PATH: &str = "/run/firecrawl-sandbox/broker.sock";
const SYSTEMD_LISTENER_FD: i32 = 3;
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 64;

fn main() -> Result<()> {
    if !nix::unistd::geteuid().is_root() {
        bail!("sandbox broker requires root");
    }
    unsafe {
        nix::libc::umask(0o077);
    }
    firecrawl_sandbox_broker::protocol::validate_shared_contract()
        .map_err(|error| anyhow::anyhow!(error))
        .context("broker contract rejected")?;
    firecrawl_sandbox_broker::protocol::validate_installed_contract()
        .map_err(|error| anyhow::anyhow!(error))
        .context("installed broker contract rejected")?;
    for bundle in [BundleId::CodexV1, BundleId::CodeNodeV1] {
        BundlePolicy::load(bundle)
            .and_then(|policy| policy.validate_installed_rootfs())
            .map_err(|error| anyhow::anyhow!(error))
            .context("installed rootfs rejected")?;
    }
    let expected_uid = expected_adapter_uid().context("adapter UID rejected")?;
    let sandbox_gid = validate_socket_activation().context("socket activation rejected")?;
    let runtime_root = PathBuf::from(RUNTIME_ROOT);
    ensure_runtime_root(&runtime_root, sandbox_gid).context("runtime root rejected")?;
    let runtime = Arc::new(BrokerRuntime::new(
        runtime_root.clone(),
        Arc::new(RealRunc::new(runtime_root)),
    ));
    runtime
        .reconcile_orphans()
        .map_err(|error| anyhow::anyhow!(error))
        .context("orphan reconciliation failed")?;
    let listener = unsafe { OwnedFd::from_raw_fd(SYSTEMD_LISTENER_FD) };
    validate_listener(listener.as_fd())
        .map_err(|error| anyhow::anyhow!(error))
        .context("listener rejected")?;
    let active_connections = Arc::new(AtomicUsize::new(0));
    loop {
        match accept_peer_or_root(listener.as_fd(), expected_uid) {
            Ok((connection, uid)) => {
                if active_connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                    active_connections.fetch_sub(1, Ordering::AcqRel);
                    drop(connection);
                    continue;
                }
                let runtime = Arc::clone(&runtime);
                let active_connections = Arc::clone(&active_connections);
                thread::spawn(move || {
                    let _permit = ConnectionPermit(active_connections);
                    if let Err(error) = serve_connection(runtime, connection, uid) {
                        let _ = error;
                    }
                });
            }
            Err(error) if error.category() == ErrorCategory::Unauthorized => continue,
            Err(error) => return Err(anyhow::anyhow!(error)).context("accept failed"),
        }
    }
}

struct ConnectionPermit(Arc<AtomicUsize>);

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn expected_adapter_uid() -> Result<u32> {
    let value =
        std::env::var("FIRECRAWL_ADAPTER_UID").context("FIRECRAWL_ADAPTER_UID is required")?;
    if value.is_empty() || value.bytes().any(|byte| !byte.is_ascii_digit()) {
        bail!("FIRECRAWL_ADAPTER_UID must be canonical decimal");
    }
    let uid = value
        .parse::<u32>()
        .context("adapter UID is out of range")?;
    if uid == 0 {
        bail!("adapter UID must be non-root");
    }
    Ok(uid)
}

fn validate_socket_activation() -> Result<u32> {
    let listen_pid = std::env::var("LISTEN_PID").context("LISTEN_PID is required")?;
    let listen_fds = std::env::var("LISTEN_FDS").context("LISTEN_FDS is required")?;
    if listen_pid != std::process::id().to_string() || listen_fds != "1" {
        bail!("exactly one listener must belong to this process");
    }
    let listener = unsafe { BorrowedFd::borrow_raw(SYSTEMD_LISTENER_FD) };
    validate_listener(listener).map_err(|error| anyhow::anyhow!(error))?;
    validate_listener_identity(listener, Path::new(BROKER_SOCKET_PATH))
}

fn validate_listener_identity(listener: BorrowedFd<'_>, expected_path: &Path) -> Result<u32> {
    let address = nix::sys::socket::getsockname::<nix::sys::socket::UnixAddr>(listener.as_raw_fd())
        .context("listener address unavailable")?;
    if address.path() != Some(expected_path) {
        bail!("listener path rejected");
    }
    let descriptor = nix::sys::stat::fstat(listener).context("listener identity unavailable")?;
    let path = std::fs::symlink_metadata(expected_path).context("listener path unavailable")?;
    if !path.file_type().is_socket()
        || path.file_type().is_symlink()
        || path.uid() != 0
        || path.gid() == 0
        || path.permissions().mode() & 0o777 != 0o660
        || path.dev() != descriptor.st_dev
        || path.ino() != descriptor.st_ino
        || path.uid() != descriptor.st_uid
        || path.gid() != descriptor.st_gid
        || descriptor.st_mode & 0o777 != 0o660
    {
        bail!("listener ownership or mode rejected");
    }
    Ok(path.gid())
}

fn validate_runtime_root_metadata(metadata: &std::fs::Metadata, expected_gid: u32) -> Result<()> {
    validate_runtime_root_fields(
        metadata.file_type().is_dir(),
        metadata.file_type().is_symlink(),
        metadata.uid(),
        metadata.gid(),
        metadata.permissions().mode() & 0o777,
        expected_gid,
    )
}

fn validate_runtime_root_fields(
    is_directory: bool,
    is_symlink: bool,
    uid: u32,
    gid: u32,
    mode: u32,
    expected_gid: u32,
) -> Result<()> {
    if expected_gid == 0
        || !is_directory
        || is_symlink
        || uid != 0
        || gid != expected_gid
        || mode != 0o750
    {
        bail!("runtime root ownership or mode rejected");
    }
    Ok(())
}

fn ensure_runtime_root(path: &std::path::Path, expected_gid: u32) -> Result<()> {
    match std::fs::create_dir(path) {
        Ok(()) => {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o750))?;
            nix::unistd::chown(
                path,
                Some(nix::unistd::Uid::from_raw(0)),
                Some(nix::unistd::Gid::from_raw(expected_gid)),
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(path)?;
    validate_runtime_root_metadata(&metadata, expected_gid)
}

fn serve_connection<R: Runc>(
    runtime: Arc<BrokerRuntime<R>>,
    connection: OwnedFd,
    uid: u32,
) -> BrokerResult<()> {
    serve_connection_with_contract_check(runtime, connection, uid, installed_contract_healthy)
}

fn serve_connection_with_contract_check<R: Runc, F: Fn() -> bool>(
    runtime: Arc<BrokerRuntime<R>>,
    connection: OwnedFd,
    uid: u32,
    installed_contract_check: F,
) -> BrokerResult<()> {
    set_timeout(connection.as_fd(), AUTHORIZATION_TIMEOUT)?;
    let packet = receive_packet(connection.as_fd())?;
    let request = parse_request(&packet.bytes)?;
    validate_request(&request)?;
    if uid == 0 && !matches!(request, BrokerRequest::Health) {
        return Err(BrokerError::new(ErrorCategory::Unauthorized));
    }
    match request {
        BrokerRequest::Prepare {
            job_id,
            adapter_boot_id,
            correlation_id,
            bundle_id,
            deadline_unix_ms,
        } => {
            let descriptors = validate_descriptors(bundle_id, uid, packet.descriptors)?;
            let worker_runtime = Arc::clone(&runtime);
            let (sender, receiver) = mpsc::sync_channel(1);
            thread::spawn(move || {
                let result = worker_runtime.prepare(
                    uid,
                    adapter_boot_id,
                    job_id,
                    correlation_id,
                    bundle_id,
                    deadline_unix_ms,
                    descriptors,
                );
                let _ = sender.send(result);
            });
            let lease = loop {
                match receiver.try_recv() {
                    Ok(result) => break result?,
                    Err(TryRecvError::Disconnected) => {
                        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
                    }
                    Err(TryRecvError::Empty) => {}
                }
                if lease_has_early_input(connection.as_fd()) {
                    cancel_prepare_and_wait(&runtime, &receiver, uid, adapter_boot_id, job_id)?;
                    return Err(BrokerError::new(ErrorCategory::Conflict));
                }
                thread::sleep(Duration::from_millis(5));
            };
            send_prepared_or_cleanup(&runtime, connection.as_fd(), uid, &lease)?;
            let deadline = lease.deadline();
            prepared_control(runtime, &connection, uid, lease, deadline)
        }
        BrokerRequest::Cancel {
            job_id,
            adapter_boot_id,
            reason,
        } => {
            reject_descriptors(&packet)?;
            let response = runtime.cancel_key(uid, adapter_boot_id, job_id, reason)?;
            send(connection.as_fd(), &response)
        }
        BrokerRequest::CancelOwner { adapter_boot_id } => {
            reject_descriptors(&packet)?;
            let response = runtime.cancel_owner(uid, adapter_boot_id)?;
            send(connection.as_fd(), &response)
        }
        BrokerRequest::Diagnose {
            correlation_id,
            job_id,
        } => {
            reject_descriptors(&packet)?;
            let diagnostic = runtime.diagnose(uid, correlation_id, job_id)?;
            send(
                connection.as_fd(),
                &BrokerResponse::Diagnostic { diagnostic },
            )
        }
        BrokerRequest::Status => {
            reject_descriptors(&packet)?;
            let status = runtime.status()?;
            send(connection.as_fd(), &BrokerResponse::StatusResult { status })
        }
        BrokerRequest::Health => {
            reject_descriptors(&packet)?;
            if !runtime.is_healthy()
                || validate_shared_contract().is_err()
                || !installed_contract_check()
            {
                return Err(BrokerError::new(ErrorCategory::CleanupFailed));
            }
            send(connection.as_fd(), &BrokerResponse::Healthy)
        }
    }
    .inspect_err(|error| {
        let _ = send_error(connection.as_fd(), error);
    })
}

fn installed_contract_healthy() -> bool {
    firecrawl_sandbox_broker::protocol::validate_installed_contract().is_ok()
}

#[cfg(test)]
fn installed_contract_healthy_at(path: &std::path::Path, expected_uid: u32) -> bool {
    firecrawl_sandbox_broker::protocol::validate_installed_contract_at(path, expected_uid).is_ok()
}

fn send_prepared_or_cleanup<R: Runc>(
    runtime: &Arc<BrokerRuntime<R>>,
    connection: BorrowedFd<'_>,
    uid: u32,
    lease: &PreparedLease,
) -> BrokerResult<()> {
    if let Err(error) = send(
        connection,
        &BrokerResponse::Prepared {
            job_id: lease.job_id(),
            init_pid: lease.init_pid(),
        },
    ) {
        let _ = runtime.connection_eof(uid, lease);
        return Err(error);
    }
    Ok(())
}

fn prepared_control<R: Runc>(
    runtime: Arc<BrokerRuntime<R>>,
    connection: &OwnedFd,
    uid: u32,
    lease: PreparedLease,
    deadline: std::time::Instant,
) -> BrokerResult<()> {
    let result = (|| {
        let wait = remaining_authorization_time(deadline)?;
        let pidfd = runtime.monitor_pidfd(uid, &lease)?;
        let mut watched = [
            PollFd::new(connection.as_fd(), PollFlags::POLLIN),
            PollFd::new(pidfd.as_fd(), PollFlags::POLLIN),
        ];
        let timeout = PollTimeout::try_from(wait)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        let ready = poll(&mut watched, timeout)
            .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        if ready == 0 {
            let response = runtime.timeout(uid, &lease)?;
            return send(connection.as_fd(), &response);
        }
        if watched[1]
            .revents()
            .is_some_and(|events| !events.is_empty())
        {
            let response = runtime.init_died(uid, &lease)?;
            return send(connection.as_fd(), &response);
        }
        let packet = receive_packet(connection.as_fd())?;
        reject_descriptors(&packet)?;
        match parse_control(&packet.bytes)? {
            PreparedControl::Abort { job_id, reason } if job_id == lease.job_id() => {
                let response = runtime.abort(uid, &lease, reason)?;
                send(connection.as_fd(), &response)
            }
            PreparedControl::Start {
                job_id,
                expected_init_pid,
            } if job_id == lease.job_id() => start_with_lease_monitor(
                Arc::clone(&runtime),
                connection,
                uid,
                lease.clone(),
                expected_init_pid,
                deadline,
            ),
            _ => Err(BrokerError::new(ErrorCategory::Conflict)),
        }
    })();
    if result.is_err() {
        let _ = runtime.connection_eof(uid, &lease);
    }
    result
}

fn start_with_lease_monitor<R: Runc>(
    runtime: Arc<BrokerRuntime<R>>,
    connection: &OwnedFd,
    uid: u32,
    lease: PreparedLease,
    expected_init_pid: u32,
    deadline: std::time::Instant,
) -> BrokerResult<()> {
    let pidfd = runtime.monitor_pidfd(uid, &lease)?;
    let worker_runtime = Arc::clone(&runtime);
    let worker_lease = lease.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = worker_runtime.start(uid, &worker_lease, expected_init_pid);
        let _ = sender.send(result);
    });
    loop {
        match receiver.try_recv() {
            Ok(result) => {
                let response = match result {
                    Ok(response) => response,
                    Err(error) if error.category() == ErrorCategory::CleanupFailed => {
                        return Err(error);
                    }
                    Err(_) if pidfd_is_ready(pidfd.as_fd())? => {
                        let response = runtime.init_died(uid, &lease)?;
                        send(connection.as_fd(), &response)?;
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                };
                send(connection.as_fd(), &response)?;
                return running_control(runtime, connection, uid, lease, deadline);
            }
            Err(TryRecvError::Disconnected) => {
                let _ = runtime.connection_eof(uid, &lease);
                return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
            }
            Err(TryRecvError::Empty) => {}
        }
        if lease_has_early_input(connection.as_fd()) {
            let packet = receive_packet(connection.as_fd());
            let cancellation = packet
                .and_then(|packet| {
                    reject_descriptors(&packet)?;
                    parse_request(&packet.bytes)
                })
                .ok()
                .and_then(|request| match request {
                    BrokerRequest::Cancel {
                        job_id,
                        adapter_boot_id,
                        reason,
                    } if job_id == lease.job_id() => Some((adapter_boot_id, reason)),
                    _ => None,
                });
            let reason = cancellation
                .map(|(_, reason)| reason)
                .unwrap_or(CancelReason::ProtocolError);
            let _ = runtime.request_cancel_lease(uid, &lease, reason);
            let worker_result = receiver
                .recv()
                .map_err(|_| BrokerError::new(ErrorCategory::SandboxUnavailable))?;
            if worker_result
                .as_ref()
                .is_err_and(|error| error.category() == ErrorCategory::CleanupFailed)
            {
                return Err(BrokerError::new(ErrorCategory::CleanupFailed));
            }
            if let Some((adapter_boot_id, reason)) = cancellation {
                let _ = worker_result;
                let response = runtime.cancel(uid, &lease, adapter_boot_id, reason)?;
                return send(connection.as_fd(), &response);
            }
            let _ = runtime.connection_eof(uid, &lease);
            return Err(BrokerError::new(ErrorCategory::Conflict));
        }
        if pidfd_is_ready(pidfd.as_fd())? {
            runtime.request_cancel_lease(uid, &lease, CancelReason::ProtocolError)?;
            let worker_result = receiver
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| BrokerError::new(ErrorCategory::CleanupFailed))?;
            if let Err(error) = worker_result
                && error.category() == ErrorCategory::CleanupFailed
            {
                return Err(error);
            }
            let response = runtime.init_died(uid, &lease)?;
            return send(connection.as_fd(), &response);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn pidfd_is_ready(pidfd: BorrowedFd<'_>) -> BrokerResult<bool> {
    let mut watched = [PollFd::new(pidfd, PollFlags::POLLIN)];
    poll(&mut watched, PollTimeout::ZERO)
        .map(|ready| ready != 0)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))
}

fn running_control<R: Runc>(
    runtime: Arc<BrokerRuntime<R>>,
    connection: &OwnedFd,
    uid: u32,
    lease: PreparedLease,
    deadline: std::time::Instant,
) -> BrokerResult<()> {
    let result = (|| {
        let pidfd = runtime.monitor_pidfd(uid, &lease)?;
        loop {
            let remaining = match remaining_job_time(deadline) {
                Ok(remaining) => remaining,
                Err(_) => {
                    let response = runtime.timeout(uid, &lease)?;
                    return send(connection.as_fd(), &response);
                }
            };
            let timeout = PollTimeout::try_from(remaining).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            let mut watched = [
                PollFd::new(connection.as_fd(), PollFlags::POLLIN),
                PollFd::new(pidfd.as_fd(), PollFlags::POLLIN),
            ];
            let ready = poll(&mut watched, timeout).map_err(|error| {
                BrokerError::with_source(ErrorCategory::SandboxUnavailable, error)
            })?;
            if ready == 0 {
                let response = runtime.timeout(uid, &lease)?;
                return send(connection.as_fd(), &response);
            }
            if watched[1]
                .revents()
                .is_some_and(|events| !events.is_empty())
            {
                let response = runtime.init_died(uid, &lease)?;
                return send(connection.as_fd(), &response);
            }
            if watched[0]
                .revents()
                .is_some_and(|events| !events.is_empty())
            {
                let packet = receive_packet(connection.as_fd())?;
                reject_descriptors(&packet)?;
                return match parse_request(&packet.bytes)? {
                    BrokerRequest::Cancel {
                        job_id,
                        adapter_boot_id,
                        reason,
                    } if job_id == lease.job_id() => {
                        let (response, artifacts) =
                            runtime.finish(uid, &lease, adapter_boot_id, reason)?;
                        send_terminal(connection.as_fd(), &response, &artifacts)
                    }
                    _ => Err(BrokerError::new(ErrorCategory::Conflict)),
                };
            }
        }
    })();
    if result.is_err() {
        let _ = runtime.connection_eof(uid, &lease);
    }
    result
}

fn send_terminal(
    fd: BorrowedFd<'_>,
    response: &BrokerResponse,
    artifacts: &[firecrawl_sandbox_broker::oci::SealedArtifact],
) -> BrokerResult<()> {
    let expected = match response {
        BrokerResponse::Terminal {
            artifacts: records, ..
        } => records.len(),
        _ => return Err(BrokerError::new(ErrorCategory::InvalidRequest)),
    };
    if expected != artifacts.len() || artifacts.len() > 8 {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let descriptors = artifacts
        .iter()
        .map(|artifact| artifact.descriptor.as_raw_fd())
        .collect::<Vec<_>>();
    send_response_with_descriptors(fd, &encode_response(response)?, &descriptors)
}

fn remaining_authorization_time(deadline: std::time::Instant) -> BrokerResult<Duration> {
    Ok(remaining_job_time(deadline)?.min(AUTHORIZATION_TIMEOUT))
}

fn remaining_job_time(deadline: std::time::Instant) -> BrokerResult<Duration> {
    let now = std::time::Instant::now();
    if now >= deadline {
        return Err(BrokerError::new(ErrorCategory::DeadlineExceeded));
    }
    Ok(deadline.duration_since(now))
}

fn cancel_prepare_and_wait<R: Runc>(
    runtime: &Arc<BrokerRuntime<R>>,
    receiver: &mpsc::Receiver<BrokerResult<PreparedLease>>,
    uid: u32,
    adapter_boot_id: uuid::Uuid,
    job_id: uuid::Uuid,
) -> BrokerResult<()> {
    loop {
        match runtime.request_cancel_key(uid, adapter_boot_id, job_id, CancelReason::ProtocolError)
        {
            Ok(()) => {
                if let Ok(Ok(lease)) = receiver.recv() {
                    let _ = runtime.connection_eof(uid, &lease);
                }
                return Ok(());
            }
            Err(error) if error.category() == ErrorCategory::Conflict => {}
            Err(error) => return Err(error),
        }
        match receiver.try_recv() {
            Ok(Ok(lease)) => {
                let _ = runtime.connection_eof(uid, &lease);
                return Ok(());
            }
            Ok(Err(_)) | Err(TryRecvError::Disconnected) => return Ok(()),
            Err(TryRecvError::Empty) => thread::sleep(Duration::from_millis(2)),
        }
    }
}

fn send(fd: BorrowedFd<'_>, response: &BrokerResponse) -> BrokerResult<()> {
    send_response(fd, &encode_response(response)?)
}

fn send_error(fd: BorrowedFd<'_>, error: &BrokerError) -> BrokerResult<()> {
    send(
        fd,
        &BrokerResponse::Error {
            category: error.category().as_str().to_owned(),
            message: error.public_message().to_owned(),
        },
    )
}

fn lease_has_early_input(connection: BorrowedFd<'_>) -> bool {
    let mut byte = [0_u8; 1];
    !matches!(
        recv(
            connection.as_raw_fd(),
            &mut byte,
            MsgFlags::MSG_PEEK | MsgFlags::MSG_DONTWAIT
        ),
        Err(nix::errno::Errno::EAGAIN)
    )
}

#[cfg(test)]
mod socket_lifecycle_tests {
    use std::io::{IoSlice, IoSliceMut, Read};
    use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::process::{Child, Command};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use firecrawl_sandbox_broker::bundles::FIXED_CODEX_CONFIG;
    use firecrawl_sandbox_broker::oci::{JobLayout, RuncStateRecord, collect_artifacts};
    use firecrawl_sandbox_broker::peer::{receive_packet, validate_descriptors};
    use firecrawl_sandbox_broker::protocol::{
        BrokerResponse, BundleId, Outcome, RuncState, SHARED_CONTRACT,
    };
    use firecrawl_sandbox_broker::redaction::{BrokerError, BrokerResult, ErrorCategory};
    use firecrawl_sandbox_broker::registry::{BrokerRuntime, ProcessIdentity, Runc};
    use nix::fcntl::{FcntlArg, OFlag, SealFlag, fcntl};
    use nix::sys::memfd::{MFdFlags, memfd_create};
    use nix::sys::signal::Signal;
    use nix::sys::socket::{
        AddressFamily, ControlMessage, ControlMessageOwned, MsgFlags, SockFlag, SockType, recvmsg,
        sendmsg, socketpair,
    };
    use nix::unistd::{Pid, pipe2, write};
    use tempfile::TempDir;
    use uuid::Uuid;

    use sha2::{Digest, Sha256};

    use super::{
        installed_contract_healthy_at, send_prepared_or_cleanup, send_terminal, serve_connection,
        serve_connection_with_contract_check, validate_runtime_root_fields,
    };

    #[test]
    fn runtime_root_requires_exact_socket_group_and_mode() {
        assert!(validate_runtime_root_fields(true, false, 0, 123, 0o750, 123).is_ok());
        for invalid in [
            (false, false, 0, 123, 0o750, 123),
            (true, true, 0, 123, 0o750, 123),
            (true, false, 1, 123, 0o750, 123),
            (true, false, 0, 0, 0o750, 0),
            (true, false, 0, 124, 0o750, 123),
            (true, false, 0, 123, 0o700, 123),
            (true, false, 0, 123, 0o751, 123),
        ] {
            assert!(
                validate_runtime_root_fields(
                    invalid.0, invalid.1, invalid.2, invalid.3, invalid.4, invalid.5
                )
                .is_err()
            );
        }
    }

    struct SocketFakeRunc {
        state: Mutex<Option<RuncStateRecord>>,
        child: Mutex<Option<Child>>,
        hold_create: AtomicBool,
    }

    impl SocketFakeRunc {
        fn new(hold_create: bool) -> Self {
            Self {
                state: Mutex::new(None),
                child: Mutex::new(None),
                hold_create: AtomicBool::new(hold_create),
            }
        }
    }

    impl Drop for SocketFakeRunc {
        fn drop(&mut self) {
            if let Some(child) = self.child.get_mut().unwrap().as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    impl Runc for SocketFakeRunc {
        fn create(
            &self,
            layout: &JobLayout,
            _bundle: BundleId,
            _descriptors: &[OwnedFd],
            _deadline: std::time::Instant,
            cancelled: &AtomicBool,
        ) -> BrokerResult<ProcessIdentity> {
            while self.hold_create.load(Ordering::Acquire) {
                if cancelled.load(Ordering::Acquire) {
                    return Err(BrokerError::new(ErrorCategory::Conflict));
                }
                thread::sleep(Duration::from_millis(2));
            }
            let child = Command::new("/usr/bin/sleep").arg("60").spawn().unwrap();
            let pid = child.id();
            std::fs::write(&layout.pid_file, format!("{pid}\n")).unwrap();
            std::fs::set_permissions(&layout.pid_file, std::fs::Permissions::from_mode(0o600))
                .unwrap();
            *self.child.lock().unwrap() = Some(child);
            *self.state.lock().unwrap() = Some(RuncStateRecord {
                oci_version: "1.2.0".to_owned(),
                id: layout.job_id.to_string(),
                pid: i64::from(pid),
                status: RuncState::Created,
                bundle: layout.directory.to_string_lossy().into_owned(),
                rootfs: "/opt/firecrawl/sandbox-bundles/codex-v1/rootfs".to_owned(),
                created: "2026-07-27T00:00:00Z".to_owned(),
                annotations: std::collections::BTreeMap::new(),
                owner: String::new(),
            });
            ProcessIdentity::open_for_test(pid)
        }

        fn state(&self, _layout: &JobLayout) -> BrokerResult<Option<RuncStateRecord>> {
            Ok(self.state.lock().unwrap().clone())
        }

        fn configure_created_network(
            &self,
            _layout: &JobLayout,
            _bundle: BundleId,
            _identity: &ProcessIdentity,
        ) -> BrokerResult<()> {
            Ok(())
        }

        fn start(
            &self,
            _layout: &JobLayout,
            _identity: &ProcessIdentity,
            _deadline: std::time::Instant,
            _cancelled: &AtomicBool,
        ) -> BrokerResult<()> {
            self.state.lock().unwrap().as_mut().unwrap().status = RuncState::Running;
            Ok(())
        }

        fn kill(&self, _layout: &JobLayout, signal: Signal) -> BrokerResult<()> {
            if let Some(child) = self.child.lock().unwrap().as_ref() {
                let _ = nix::sys::signal::kill(Pid::from_raw(child.id() as i32), signal);
            }
            Ok(())
        }

        fn delete_force(&self, _layout: &JobLayout) -> BrokerResult<()> {
            if let Some(mut child) = self.child.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *self.state.lock().unwrap() = None;
            Ok(())
        }

        fn list(&self, _runtime_root: &std::path::Path) -> BrokerResult<Vec<Uuid>> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn malformed_prepared_and_running_packets_converge_on_cleanup() {
        for start_first in [false, true] {
            let fixture = SocketFixture::new(false);
            fixture.send_prepare(now_ms() + 10_000);
            let prepared = fixture.receive();
            let init_pid = prepared["init_pid"].as_u64().unwrap();
            if start_first {
                fixture.send_json(
                    &serde_json::json!({
                        "method":"start",
                        "job_id":fixture.job_id,
                        "expected_init_pid":init_pid
                    }),
                    &[],
                );
                assert_eq!(fixture.receive()["type"], "started");
            }
            let extra = memfd_create("unexpected", MFdFlags::MFD_CLOEXEC).unwrap();
            fixture.send_json(
                &serde_json::json!({"method":"health"}),
                &[extra.as_raw_fd()],
            );
            let _ = fixture.receive_optional();
            fixture.join();
            assert!(!fixture.job_directory().exists());
            assert!(fixture.runc.state.lock().unwrap().is_none());
        }
    }

    #[test]
    fn authorization_deadline_after_prepared_cleans_without_control() {
        let fixture = SocketFixture::new(false);
        fixture.send_prepare(now_ms() + 100);
        assert_eq!(fixture.receive()["type"], "prepared");
        fixture.join();
        assert!(!fixture.job_directory().exists());
        assert!(fixture.runc.state.lock().unwrap().is_none());
    }

    #[test]
    fn prepared_control_lease_detects_init_death_via_pidfd() {
        let fixture = SocketFixture::new(false);
        fixture.send_prepare(now_ms() + 10_000);
        assert_eq!(fixture.receive()["type"], "prepared");
        {
            let mut child = fixture.runc.child.lock().unwrap();
            let child = child.as_mut().unwrap();
            child.kill().unwrap();
            child.wait().unwrap();
        }
        let terminal = fixture.receive();
        assert_eq!(terminal["type"], "terminal");
        assert_eq!(terminal["outcome"], "failed");
        fixture.join();
        assert!(!fixture.job_directory().exists());
    }

    #[test]
    fn prepared_send_failure_runs_exact_lease_cleanup() {
        let root = secure_temp();
        let runc = Arc::new(SocketFakeRunc::new(false));
        let runtime = Arc::new(BrokerRuntime::new(
            root.path().to_path_buf(),
            Arc::clone(&runc),
        ));
        let uid = nix::unistd::geteuid().as_raw();
        let job_id = Uuid::new_v4();
        let lease = runtime
            .prepare(
                uid,
                Uuid::new_v4(),
                job_id,
                Uuid::new_v4(),
                BundleId::CodexV1,
                now_ms() + 60_000,
                valid_codex_descriptors(uid),
            )
            .unwrap();
        let (broker, adapter) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        drop(adapter);
        assert!(send_prepared_or_cleanup(&runtime, broker.as_fd(), uid, &lease).is_err());
        assert!(!root.path().join("jobs").join(job_id.to_string()).exists());
    }

    #[test]
    fn root_peer_is_health_only() {
        let root = secure_temp();
        let runtime = Arc::new(BrokerRuntime::new(
            root.path().to_path_buf(),
            Arc::new(SocketFakeRunc::new(false)),
        ));
        let (broker, adapter) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let worker = {
            let runtime = Arc::clone(&runtime);
            thread::spawn(move || serve_connection_with_contract_check(runtime, broker, 0, || true))
        };
        let bytes = serde_json::to_vec(&serde_json::json!({"method":"health"})).unwrap();
        sendmsg::<()>(
            adapter.as_raw_fd(),
            &[IoSlice::new(&bytes)],
            &[],
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        let response = receive_packet(adapter.as_fd()).unwrap();
        assert_eq!(
            firecrawl_sandbox_broker::protocol::strict_json::<BrokerResponse>(&response.bytes)
                .unwrap(),
            BrokerResponse::Healthy
        );
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn health_contract_check_rejects_tamper_and_symlink() {
        let root = secure_temp();
        let contract = root.path().join("sandbox-broker-v1.contract.json");
        std::fs::write(&contract, SHARED_CONTRACT).unwrap();
        std::fs::set_permissions(&contract, std::fs::Permissions::from_mode(0o600)).unwrap();
        let uid = nix::unistd::geteuid().as_raw();
        assert!(installed_contract_healthy_at(&contract, uid));

        std::fs::write(&contract, format!("{SHARED_CONTRACT} ")).unwrap();
        assert!(!installed_contract_healthy_at(&contract, uid));

        std::fs::remove_file(&contract).unwrap();
        let target = root.path().join("target");
        std::fs::write(&target, SHARED_CONTRACT).unwrap();
        symlink(&target, &contract).unwrap();
        assert!(!installed_contract_healthy_at(&contract, uid));
    }

    #[test]
    fn terminal_artifact_descriptor_order_and_offset_are_exact() {
        let root = secure_temp();
        let files = root.path().join("files");
        std::fs::create_dir(&files).unwrap();
        let contents = b"\x89PNG\r\n\x1a\nterminal-artifact";
        std::fs::write(files.join("result.png"), contents).unwrap();
        let checksum = Sha256::digest(contents)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        std::fs::write(
            root.path().join("manifest.json"),
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
        let artifacts = collect_artifacts(root.path()).unwrap();
        let response = BrokerResponse::Terminal {
            job_id: Uuid::new_v4(),
            init_pid: 7,
            outcome: Outcome::Completed,
            artifacts: artifacts
                .iter()
                .map(|artifact| artifact.record.clone())
                .collect(),
        };
        let (broker, adapter) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        send_terminal(broker.as_fd(), &response, &artifacts).unwrap();
        let mut bytes = [0_u8; 65_536];
        let mut iov = [IoSliceMut::new(&mut bytes)];
        let mut control = nix::cmsg_space!([i32; 8]);
        let message = recvmsg::<()>(
            adapter.as_raw_fd(),
            &mut iov,
            Some(&mut control),
            MsgFlags::MSG_CMSG_CLOEXEC,
        )
        .unwrap();
        let received = message
            .cmsgs()
            .unwrap()
            .flat_map(|message| match message {
                ControlMessageOwned::ScmRights(descriptors) => descriptors,
                _ => Vec::new(),
            })
            .collect::<Vec<_>>();
        assert_eq!(received.len(), 1);
        let mut file = unsafe { std::fs::File::from_raw_fd(received[0]) };
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, contents);
    }

    #[test]
    fn immediate_eof_before_registry_insertion_cannot_publish_or_leak() {
        let fixture = SocketFixture::new(true);
        fixture.send_prepare(now_ms() + 10_000);
        fixture.close_adapter();
        fixture.join();
        assert!(!fixture.job_directory().exists());
        assert!(fixture.runc.state.lock().unwrap().is_none());
    }

    #[test]
    fn another_connection_cannot_start_prepared_job() {
        let fixture = SocketFixture::new(false);
        fixture.send_prepare(now_ms() + 10_000);
        let prepared = fixture.receive();
        let init_pid = prepared["init_pid"].as_u64().unwrap();
        let (broker, adapter) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let runtime = Arc::clone(&fixture.runtime);
        let uid = nix::unistd::geteuid().as_raw();
        let worker = thread::spawn(move || serve_connection(runtime, broker, uid));
        let bytes = serde_json::to_vec(&serde_json::json!({
            "method":"start",
            "job_id":fixture.job_id,
            "expected_init_pid":init_pid
        }))
        .unwrap();
        sendmsg::<()>(
            adapter.as_raw_fd(),
            &[IoSlice::new(&bytes)],
            &[],
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        assert!(worker.join().unwrap().is_err());

        fixture.send_json(
            &serde_json::json!({
                "method":"abort",
                "job_id":fixture.job_id,
                "reason":"authorization_failed"
            }),
            &[],
        );
        assert_eq!(fixture.receive()["type"], "aborted");
        fixture.join();
        assert!(!fixture.job_directory().exists());
    }

    struct SocketFixture {
        root: TempDir,
        adapter: Mutex<Option<OwnedFd>>,
        runtime: Arc<BrokerRuntime<SocketFakeRunc>>,
        job_id: Uuid,
        boot_id: Uuid,
        correlation_id: Uuid,
        runc: Arc<SocketFakeRunc>,
        thread: Mutex<Option<thread::JoinHandle<BrokerResult<()>>>>,
    }

    impl SocketFixture {
        fn new(hold_create: bool) -> Self {
            let root = tempfile::tempdir().unwrap();
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let runc = Arc::new(SocketFakeRunc::new(hold_create));
            let runtime = Arc::new(BrokerRuntime::new(
                root.path().to_path_buf(),
                Arc::clone(&runc),
            ));
            let (broker, adapter) = socketpair(
                AddressFamily::Unix,
                SockType::SeqPacket,
                None,
                SockFlag::SOCK_CLOEXEC,
            )
            .unwrap();
            let uid = nix::unistd::geteuid().as_raw();
            let worker_runtime = Arc::clone(&runtime);
            let handle = thread::spawn(move || serve_connection(worker_runtime, broker, uid));
            Self {
                root,
                adapter: Mutex::new(Some(adapter)),
                runtime,
                job_id: Uuid::new_v4(),
                boot_id: Uuid::new_v4(),
                correlation_id: Uuid::new_v4(),
                runc,
                thread: Mutex::new(Some(handle)),
            }
        }

        fn send_prepare(&self, deadline_unix_ms: u64) {
            let (stdin, _stdin_writer) = pipe2(OFlag::O_CLOEXEC).unwrap();
            let (_stdout_reader, stdout) = pipe2(OFlag::O_CLOEXEC).unwrap();
            let (_stderr_reader, stderr) = pipe2(OFlag::O_CLOEXEC).unwrap();
            let descriptors = [stdin.as_raw_fd(), stdout.as_raw_fd(), stderr.as_raw_fd()];
            let auth = sealed("socket-auth", b"{}");
            let config = sealed("socket-config", FIXED_CODEX_CONFIG.as_bytes());
            let all = [
                descriptors[0],
                descriptors[1],
                descriptors[2],
                auth.as_raw_fd(),
                config.as_raw_fd(),
            ];
            self.send_json(
                &serde_json::json!({
                    "method":"prepare",
                    "job_id":self.job_id,
                    "adapter_boot_id":self.boot_id,
                    "correlation_id":self.correlation_id,
                    "bundle_id":"codex-v1",
                    "deadline_unix_ms":deadline_unix_ms
                }),
                &all,
            );
        }

        fn send_json(&self, value: &serde_json::Value, descriptors: &[i32]) {
            let bytes = serde_json::to_vec(value).unwrap();
            let adapter = self.adapter.lock().unwrap();
            let adapter = adapter.as_ref().unwrap();
            let controls = if descriptors.is_empty() {
                Vec::new()
            } else {
                vec![ControlMessage::ScmRights(descriptors)]
            };
            sendmsg::<()>(
                adapter.as_raw_fd(),
                &[IoSlice::new(&bytes)],
                &controls,
                MsgFlags::empty(),
                None,
            )
            .unwrap();
        }

        fn receive(&self) -> serde_json::Value {
            self.receive_optional().unwrap()
        }

        fn receive_optional(&self) -> Option<serde_json::Value> {
            let adapter = self.adapter.lock().unwrap();
            let adapter = adapter.as_ref()?;
            let mut bytes = [0_u8; 65_536];
            let count =
                nix::sys::socket::recv(adapter.as_raw_fd(), &mut bytes, MsgFlags::empty()).ok()?;
            if count == 0 {
                return None;
            }
            serde_json::from_slice(&bytes[..count]).ok()
        }

        fn close_adapter(&self) {
            self.adapter.lock().unwrap().take();
        }

        fn join(&self) {
            self.thread
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .join()
                .unwrap()
                .ok();
        }

        fn job_directory(&self) -> std::path::PathBuf {
            self.root.path().join("jobs").join(self.job_id.to_string())
        }
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

    fn valid_codex_descriptors(uid: u32) -> firecrawl_sandbox_broker::peer::ValidatedDescriptors {
        let (stdin, _stdin_writer) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let (_stdout_reader, stdout) = pipe2(OFlag::O_CLOEXEC).unwrap();
        let (_stderr_reader, stderr) = pipe2(OFlag::O_CLOEXEC).unwrap();
        validate_descriptors(
            BundleId::CodexV1,
            uid,
            vec![
                stdin,
                stdout,
                stderr,
                sealed("direct-auth", b"{}"),
                sealed("direct-config", FIXED_CODEX_CONFIG.as_bytes()),
            ],
        )
        .unwrap()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    fn secure_temp() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }
}
