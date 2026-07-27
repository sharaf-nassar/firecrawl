use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use firecrawl_sandbox_broker::bundles::BundlePolicy;
use firecrawl_sandbox_broker::oci::{RuncStateRecord, parse_runc_state, read_secure_child};
use firecrawl_sandbox_broker::peer::{
    receive_packet, reject_descriptors, send_response, set_timeout,
};
use firecrawl_sandbox_broker::protocol::{
    BrokerRequest, BrokerResponse, BundleId, RuncState, strict_json,
};
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::sys::socket::{
    AddressFamily, SockFlag, SockType, UnixAddr, connect, getsockopt, socket, sockopt,
};
use serde::Deserialize;
use uuid::Uuid;

const SERVICE: &str = "firecrawl-sandbox-broker.service";
const SOCKET: &str = "firecrawl-sandbox-broker.socket";
const BROKER_SOCKET_PATH: &str = "/run/firecrawl-sandbox/broker.sock";
const JOBS_ROOT_BENEATH_FS_ROOT: &str = "run/firecrawl-sandbox/jobs";
const RUNC_ROOT: &str = "/run/firecrawl-sandbox/runc";
const WAIT_BOUND: Duration = Duration::from_secs(10);
const COMMAND_BOUND: Duration = Duration::from_secs(5);
const COMMAND_OUTPUT_BOUND: usize = 64 * 1024;
const OPENAT2_RESOLVE_NO_SYMLINKS: u64 = 0x04;
const OPENAT2_RESOLVE_BENEATH: u64 = 0x08;

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Attestation {
    version: u32,
    correlation_id: Uuid,
    job_id: Uuid,
    phase: Phase,
    init_pid: u32,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Prepared,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

fn main() -> Result<()> {
    let action = parse_args(std::env::args().skip(1).collect())?;
    if !nix::unistd::geteuid().is_root() {
        bail!("acceptance helper requires root");
    }
    validate_fixed_units()?;
    match action {
        Action::Check => Ok(()),
        Action::Restart {
            correlation_id,
            job_id,
        } => restart_prepared(correlation_id, job_id),
    }
}

#[derive(Debug, Eq, PartialEq)]
enum Action {
    Check,
    Restart { correlation_id: Uuid, job_id: Uuid },
}

fn parse_args(args: Vec<String>) -> Result<Action> {
    match args.as_slice() {
        [check] if check == "--check" => Ok(Action::Check),
        [restart, correlation_id, job_id] if restart == "--restart-prepared" => {
            Ok(Action::Restart {
                correlation_id: parse_canonical_uuid(correlation_id)?,
                job_id: parse_canonical_uuid(job_id)?,
            })
        }
        _ => bail!(
            "usage: acceptance-restart-broker --check | --restart-prepared <correlation-id> <job-id>"
        ),
    }
}

fn parse_canonical_uuid(value: &str) -> Result<Uuid> {
    let parsed = Uuid::parse_str(value).context("UUID rejected")?;
    if parsed.is_nil() || parsed.to_string() != value {
        bail!("UUID must be non-nil canonical lowercase");
    }
    Ok(parsed)
}

fn validate_fixed_units() -> Result<()> {
    for unit in [SERVICE, SOCKET] {
        let output = systemctl(&["show", "--property=LoadState", "--value", unit])?;
        if output.trim() != "loaded" {
            bail!("required fixed unit is not loaded");
        }
    }
    Ok(())
}

fn restart_prepared(correlation_id: Uuid, job_id: Uuid) -> Result<()> {
    let jobs = open_jobs_root()?;
    let job_name = job_id.to_string();
    let directory = open_secure_directory_beneath(&jobs, &job_name, 0o700, 0)
        .context("job directory unavailable")?;
    let identity = file_identity(&directory)?;
    validate_prepared_snapshot(&jobs, &directory, identity, correlation_id, job_id)?;

    let old_pid = service_main_pid()?;
    let old_pidfd = open_pidfd(old_pid).context("broker MainPID rejected")?;
    validate_pidfd_identity(old_pidfd.as_fd(), old_pid)?;

    // Revalidate every mutable trust input at the last possible point before
    // invoking the single fixed destructive operation.
    validate_prepared_snapshot(&jobs, &directory, identity, correlation_id, job_id)?;
    if service_main_pid()? != old_pid {
        bail!("broker MainPID changed before restart");
    }
    validate_pidfd_identity(old_pidfd.as_fd(), old_pid)?;

    systemctl(&["kill", "--signal=SIGKILL", "--kill-whom=main", SERVICE])?;
    wait_pidfd_exit(old_pidfd.as_fd(), WAIT_BOUND)?;
    systemctl(&["start", SERVICE])?;
    wait_replacement_healthy(old_pid)
}

fn open_jobs_root() -> Result<File> {
    let filesystem_root = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open("/")
        .context("filesystem root unavailable")?;
    open_secure_directory_beneath(&filesystem_root, JOBS_ROOT_BENEATH_FS_ROOT, 0o700, 0)
        .context("jobs root unavailable")
}

fn open_secure_directory_beneath(
    parent: &File,
    relative: &str,
    required_mode: u32,
    required_uid: u32,
) -> Result<File> {
    if relative.is_empty() || relative.starts_with('/') || relative.as_bytes().contains(&0) {
        bail!("directory path rejected");
    }
    let name = CString::new(relative).context("directory path rejected")?;
    let how = OpenHow {
        flags: (nix::libc::O_RDONLY
            | nix::libc::O_DIRECTORY
            | nix::libc::O_CLOEXEC
            | nix::libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: OPENAT2_RESOLVE_BENEATH | OPENAT2_RESOLVE_NO_SYMLINKS,
    };
    let raw = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_openat2,
            parent.as_raw_fd(),
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        return Err(std::io::Error::last_os_error()).context("directory unavailable");
    }
    let directory = unsafe { File::from_raw_fd(raw as RawFd) };
    let metadata = directory.metadata().context("directory unavailable")?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != required_uid
        || metadata.mode() & 0o777 != required_mode
    {
        bail!("directory ownership or mode rejected");
    }
    Ok(directory)
}

fn file_identity(file: &File) -> Result<FileIdentity> {
    let metadata = file.metadata().context("directory identity unavailable")?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn validate_job_path_identity(jobs: &File, job_name: &str, expected: FileIdentity) -> Result<()> {
    let current = open_secure_directory_beneath(jobs, job_name, 0o700, 0)
        .context("job directory unavailable")?;
    if file_identity(&current)? != expected {
        bail!("job directory identity changed");
    }
    Ok(())
}

fn validate_prepared_snapshot(
    jobs: &File,
    directory: &File,
    identity: FileIdentity,
    correlation_id: Uuid,
    job_id: Uuid,
) -> Result<()> {
    let job_name = job_id.to_string();
    validate_job_path_identity(jobs, &job_name, identity)?;
    let attestation = read_attestation(directory)?;
    let pid = strict_pid(
        &read_secure_child(directory, "pid", 32, 0o600, 0)
            .map_err(|error| anyhow::anyhow!(error))
            .context("pid file unavailable")?,
    )?;
    let state = runc_state(job_id, directory)?;
    validate_prepared_inputs(&attestation, pid, &state, correlation_id, job_id)?;
    validate_job_path_identity(jobs, &job_name, identity)?;
    Ok(())
}

fn validate_prepared_inputs(
    attestation: &Attestation,
    pid: u32,
    state: &RuncStateRecord,
    correlation_id: Uuid,
    job_id: Uuid,
) -> Result<()> {
    if attestation.version != 1
        || attestation.phase != Phase::Prepared
        || attestation.correlation_id != correlation_id
        || attestation.job_id != job_id
        || attestation.init_pid == 0
    {
        bail!("attestation identity rejected");
    }
    if pid != attestation.init_pid {
        bail!("pid identity rejected");
    }
    if state.id != job_id.to_string()
        || state.pid != i64::from(pid)
        || state.status != RuncState::Created
    {
        bail!("runc state identity rejected");
    }
    Ok(())
}

fn read_attestation(directory: &File) -> Result<Attestation> {
    let bytes = read_secure_child(directory, "acceptance.json", 64 * 1024, 0o600, 0)
        .map_err(|error| anyhow::anyhow!(error))
        .context("attestation unavailable")?;
    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    let attestation =
        Attestation::deserialize(&mut deserializer).context("attestation rejected")?;
    deserializer.end().context("attestation rejected")?;
    Ok(attestation)
}

fn strict_pid(bytes: &[u8]) -> Result<u32> {
    let digits = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if digits.is_empty()
        || digits.len() > 10
        || digits.iter().any(|byte| !byte.is_ascii_digit())
        || (digits.len() > 1 && digits[0] == b'0')
        || bytes
            .strip_suffix(b"\n")
            .is_some_and(|_| bytes.ends_with(b"\n\n"))
    {
        bail!("pid rejected");
    }
    let pid = std::str::from_utf8(digits)?.parse::<u32>()?;
    if pid == 0 || pid > i32::MAX as u32 {
        bail!("pid rejected");
    }
    Ok(pid)
}

fn runc_state(job_id: Uuid, directory: &File) -> Result<RuncStateRecord> {
    let output = run_bounded(
        "/usr/bin/runc",
        &["--root", RUNC_ROOT, "state", &job_id.to_string()],
    )
    .context("runc state failed")?;
    if !output.status.success() {
        bail!("runc state failed");
    }
    let preliminary: RuncStateRecord = strict_json(&output.stdout)
        .map_err(|error| anyhow::anyhow!(error))
        .context("runc state rejected")?;
    let bundle_id = match preliminary
        .annotations
        .get("com.firecrawl.bundle")
        .map(String::as_str)
    {
        Some("codex-v1") => BundleId::CodexV1,
        Some("code-node-v1") => BundleId::CodeNodeV1,
        Some("code-python-v1") => BundleId::CodePythonV1,
        Some("code-bash-v1") => BundleId::CodeBashV1,
        _ => bail!("runc bundle rejected"),
    };
    let policy = BundlePolicy::load(bundle_id)
        .map_err(|error| anyhow::anyhow!(error))
        .context("runc bundle rejected")?;
    let pinned_bundle = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
    parse_runc_state(
        &output.stdout,
        job_id,
        &pinned_bundle,
        &policy.rootfs,
        bundle_id,
    )
    .map_err(|error| anyhow::anyhow!(error))
    .context("runc state rejected")
}

struct BoundedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

fn run_bounded(program: &str, arguments: &[&str]) -> Result<BoundedOutput> {
    run_bounded_with_bound(program, arguments, COMMAND_BOUND)
}

fn run_bounded_with_bound(
    program: &str,
    arguments: &[&str],
    bound: Duration,
) -> Result<BoundedOutput> {
    let mut child = Command::new(program)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("fixed command failed")?;
    let mut stdout = child
        .stdout
        .take()
        .context("fixed command output unavailable")?;
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
        let _ = reap_bounded(&mut child, bound);
        bail!("fixed command output unavailable");
    }
    let deadline = Instant::now() + bound;
    let mut bytes = Vec::new();
    let mut eof = false;
    let mut status = None;
    loop {
        loop {
            let mut buffer = [0_u8; 8192];
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(count) => {
                    bytes.extend_from_slice(&buffer[..count]);
                    if bytes.len() > COMMAND_OUTPUT_BOUND {
                        let _ = child.kill();
                        let _ = reap_bounded(&mut child, bound);
                        bail!("fixed command output exceeded bound");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => {
                    let _ = child.kill();
                    let _ = reap_bounded(&mut child, bound);
                    return Err(error).context("fixed command output failed");
                }
            }
        }
        if status.is_none() {
            status = child.try_wait().context("fixed command failed")?;
        }
        if let Some(status) = status
            && eof
        {
            return Ok(BoundedOutput {
                status,
                stdout: bytes,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = reap_bounded(&mut child, bound);
            bail!("fixed command timed out");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn reap_bounded(child: &mut std::process::Child, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        if child.try_wait().ok().flatten().is_some() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn systemctl(arguments: &[&str]) -> Result<String> {
    let output = run_bounded("/usr/bin/systemctl", arguments).context("systemctl failed")?;
    if !output.status.success() {
        bail!("fixed systemctl operation failed");
    }
    String::from_utf8(output.stdout).context("systemctl output rejected")
}

fn service_main_pid() -> Result<u32> {
    let output = systemctl(&["show", "--property=MainPID", "--value", SERVICE])?;
    strict_pid(output.as_bytes())
}

fn open_pidfd(pid: u32) -> Result<OwnedFd> {
    let raw = unsafe { nix::libc::syscall(nix::libc::SYS_pidfd_open, pid, 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error()).context("pidfd_open failed");
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw as RawFd) })
}

fn validate_pidfd_identity(pidfd: BorrowedFd<'_>, expected_pid: u32) -> Result<()> {
    let path = format!("/proc/self/fdinfo/{}", pidfd.as_raw_fd());
    let bytes = fs::read(path).context("pidfd identity unavailable")?;
    let mut found = None;
    for line in bytes.split(|byte| *byte == b'\n') {
        if let Some(value) = line.strip_prefix(b"Pid:\t") {
            found = Some(strict_pid(value)?);
        }
    }
    if found != Some(expected_pid) {
        bail!("pidfd identity rejected");
    }
    let mut descriptors = [PollFd::new(pidfd, PollFlags::POLLIN)];
    if poll(&mut descriptors, PollTimeout::ZERO)? != 0 {
        bail!("broker MainPID exited before restart");
    }
    Ok(())
}

fn wait_pidfd_exit(pidfd: BorrowedFd<'_>, bound: Duration) -> Result<()> {
    let mut descriptors = [PollFd::new(pidfd, PollFlags::POLLIN)];
    let timeout = PollTimeout::try_from(bound).context("pidfd wait bound rejected")?;
    if poll(&mut descriptors, timeout)? != 1
        || !descriptors[0]
            .revents()
            .is_some_and(|flags| flags.contains(PollFlags::POLLIN))
    {
        bail!("old broker remained alive");
    }
    Ok(())
}

fn wait_replacement_healthy(old_pid: u32) -> Result<()> {
    let deadline = Instant::now() + WAIT_BOUND;
    loop {
        if let Ok(new_pid) = service_main_pid()
            && new_pid != old_pid
            && broker_health(new_pid).is_ok()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("replacement broker did not become healthy");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn broker_health(expected_pid: u32) -> Result<()> {
    let connection = socket(
        AddressFamily::Unix,
        SockType::SeqPacket,
        SockFlag::SOCK_CLOEXEC,
        None,
    )
    .context("broker health socket failed")?;
    let address = UnixAddr::new(Path::new(BROKER_SOCKET_PATH))
        .context("broker health socket path rejected")?;
    connect(connection.as_raw_fd(), &address).context("broker health connect failed")?;
    health_exchange(connection.as_fd(), expected_pid, 0)
}

fn health_exchange(connection: BorrowedFd<'_>, expected_pid: u32, expected_uid: u32) -> Result<()> {
    set_timeout(connection, Duration::from_secs(1))
        .map_err(|error| anyhow::anyhow!(error))
        .context("broker health timeout failed")?;
    let credentials =
        getsockopt(&connection, sockopt::PeerCredentials).context("broker peer rejected")?;
    if credentials.pid() != expected_pid as i32 || credentials.uid() != expected_uid {
        bail!("broker peer identity rejected");
    }
    let request = serde_json::to_vec(&BrokerRequest::Health).context("health request failed")?;
    send_response(connection, &request)
        .map_err(|error| anyhow::anyhow!(error))
        .context("health request failed")?;
    let packet = receive_packet(connection)
        .map_err(|error| anyhow::anyhow!(error))
        .context("health response failed")?;
    reject_descriptors(&packet)
        .map_err(|error| anyhow::anyhow!(error))
        .context("health response rejected")?;
    let response: BrokerResponse = strict_json(&packet.bytes)
        .map_err(|error| anyhow::anyhow!(error))
        .context("health response rejected")?;
    if response != BrokerResponse::Healthy {
        bail!("broker health response rejected");
    }
    Ok(())
}

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsFd;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use nix::sys::socket::{AddressFamily, SockFlag, SockType, socketpair};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn parser_accepts_only_closed_actions() {
        let correlation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let job = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        assert_eq!(parse_args(vec!["--check".into()]).unwrap(), Action::Check);
        assert!(matches!(
            parse_args(vec![
                "--restart-prepared".into(),
                correlation.into(),
                job.into()
            ])
            .unwrap(),
            Action::Restart { .. }
        ));
        for invalid in [
            vec![],
            vec!["--check".into(), SERVICE.into()],
            vec!["--restart-prepared".into(), correlation.into()],
            vec![
                "--restart-prepared".into(),
                correlation.into(),
                job.into(),
                "other.service".into(),
            ],
        ] {
            assert!(parse_args(invalid).is_err());
        }
    }

    #[test]
    fn pid_parser_is_canonical_and_bounded() {
        assert_eq!(strict_pid(b"123\n").unwrap(), 123);
        for invalid in [b"".as_slice(), b"0", b"01", b"+1", b"1\n\n", b"2147483648"] {
            assert!(strict_pid(invalid).is_err());
        }
    }

    #[test]
    fn prepared_inputs_reject_attestation_pid_and_state_changes() {
        let correlation_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let job_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let mut attestation = Attestation {
            version: 1,
            correlation_id,
            job_id,
            phase: Phase::Prepared,
            init_pid: 123,
        };
        let mut state = RuncStateRecord {
            oci_version: "1.0.2".into(),
            id: job_id.to_string(),
            pid: 123,
            status: RuncState::Created,
            bundle: "/run/firecrawl-sandbox/jobs/example".into(),
            rootfs: "/run/firecrawl-sandbox/jobs/example/rootfs".into(),
            created: "2026-07-27T00:00:00Z".into(),
            annotations: Default::default(),
            owner: String::new(),
        };
        assert!(
            validate_prepared_inputs(&attestation, 123, &state, correlation_id, job_id).is_ok()
        );

        attestation.correlation_id = Uuid::new_v4();
        assert!(
            validate_prepared_inputs(&attestation, 123, &state, correlation_id, job_id).is_err()
        );
        attestation.correlation_id = correlation_id;
        assert!(
            validate_prepared_inputs(&attestation, 124, &state, correlation_id, job_id).is_err()
        );
        state.status = RuncState::Running;
        assert!(
            validate_prepared_inputs(&attestation, 123, &state, correlation_id, job_id).is_err()
        );
    }

    #[test]
    fn beneath_open_rejects_symlinks_and_directory_replacement() {
        let temporary = tempdir().unwrap();
        let parent_path = temporary.path().join("parent");
        fs::create_dir(&parent_path).unwrap();
        fs::set_permissions(&parent_path, fs::Permissions::from_mode(0o700)).unwrap();
        let job_path = parent_path.join("job");
        fs::create_dir(&job_path).unwrap();
        fs::set_permissions(&job_path, fs::Permissions::from_mode(0o700)).unwrap();
        let parent = File::open(&parent_path).unwrap();
        let directory =
            open_secure_directory_beneath(&parent, "job", 0o700, nix::unistd::geteuid().as_raw())
                .unwrap();
        let identity = file_identity(&directory).unwrap();

        fs::rename(&job_path, parent_path.join("old")).unwrap();
        fs::create_dir(&job_path).unwrap();
        fs::set_permissions(&job_path, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_job_path_identity(&parent, "job", identity).is_err());

        fs::remove_dir(&job_path).unwrap();
        symlink(parent_path.join("old"), &job_path).unwrap();
        assert!(
            open_secure_directory_beneath(&parent, "job", 0o700, nix::unistd::geteuid().as_raw())
                .is_err()
        );
        assert!(
            open_secure_directory_beneath(
                &parent,
                "../parent/old",
                0o700,
                nix::unistd::geteuid().as_raw()
            )
            .is_err()
        );
    }

    #[test]
    fn health_exchange_authenticates_peer_and_exact_response() {
        let uid = nix::unistd::geteuid().as_raw();
        let (client, server) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let server_thread = thread::spawn(move || {
            let packet = receive_packet(server.as_fd()).unwrap();
            assert_eq!(
                strict_json::<BrokerRequest>(&packet.bytes).unwrap(),
                BrokerRequest::Health
            );
            send_response(
                server.as_fd(),
                &serde_json::to_vec(&BrokerResponse::Healthy).unwrap(),
            )
            .unwrap();
        });
        health_exchange(client.as_fd(), std::process::id(), uid).unwrap();
        server_thread.join().unwrap();
    }

    #[test]
    fn health_exchange_rejects_wrong_pid_and_wrong_response() {
        let uid = nix::unistd::geteuid().as_raw();
        let (client, server) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        assert!(health_exchange(client.as_fd(), std::process::id() + 1, uid).is_err());
        drop(server);

        let (client, server) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let server_thread = thread::spawn(move || {
            let _ = receive_packet(server.as_fd()).unwrap();
            send_response(
                server.as_fd(),
                &serde_json::to_vec(&BrokerResponse::OwnerCancelled).unwrap(),
            )
            .unwrap();
        });
        assert!(health_exchange(client.as_fd(), std::process::id(), uid).is_err());
        server_thread.join().unwrap();
    }

    #[test]
    fn bounded_command_rejects_descendant_held_output_without_blocking() {
        let started = Instant::now();
        assert!(
            run_bounded_with_bound("/bin/sh", &["-c", "sleep 2 &"], Duration::from_millis(50),)
                .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
