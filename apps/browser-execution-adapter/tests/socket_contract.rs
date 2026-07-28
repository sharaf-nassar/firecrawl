use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader as StdBufReader, IoSlice, IoSliceMut, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};

use firecrawl_browser_execution_adapter::app_server::ProtocolBundle;
use firecrawl_browser_execution_adapter::broker_client::{
    BrokerCancelReason, BrokerClient, BrokerPhase, BrokerRuncState, BrokerTerminal,
    BrokerTerminalOutcome, validate_shared_contract, validate_shared_contract_bytes,
};
use firecrawl_browser_execution_adapter::config::AdapterConfig;
use firecrawl_browser_execution_adapter::jobs::AdapterRequest;
use firecrawl_browser_execution_adapter::jobs::{AdapterService, JobCompletion, JobRegistry};
use firecrawl_browser_execution_adapter::protocol::parse_json_strict;
use nix::cmsg_space;
use nix::fcntl::{FcntlArg, OFlag, SealFlag, fcntl};
use nix::sys::memfd::{MFdFlags, memfd_create};
use nix::sys::socket::{
    AddressFamily, Backlog, ControlMessage, ControlMessageOwned, MsgFlags, Shutdown, SockFlag,
    SockType, UnixAddr, accept, bind, listen, recv, recvmsg, send, sendmsg, shutdown, socket,
};
use nix::unistd::{Whence, lseek, pipe2, write};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::Duration;
use uuid::Uuid;

const INIT_PID: u32 = 4242;

fn temporary_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!("firecrawl-adapter-test-{}", Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[test]
fn health_and_diagnostic_requests_are_closed_and_canonical() {
    let request_id = Uuid::new_v4();
    let correlation_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    for accepted in [
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "health",
            "body": {}
        }),
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "status",
            "body": {}
        }),
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "diagnose_host_job",
            "body": {"correlationId": correlation_id, "jobId": job_id}
        }),
    ] {
        assert!(parse_json_strict::<AdapterRequest>(accepted.to_string().as_bytes()).is_ok());
    }
    for rejected in [
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "health",
            "body": {"extra": true}
        }),
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "status",
            "body": {"extra": true}
        }),
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "diagnose_host_job",
            "body": {
                "correlationId": correlation_id,
                "jobId": job_id,
                "extra": true
            }
        }),
        json!({
            "version": 1,
            "requestId": request_id,
            "method": "diagnose_host_job",
            "body": {
                "correlationId": correlation_id.to_string().to_uppercase(),
                "jobId": job_id
            }
        }),
        json!({
            "version": 1,
            "requestId": Uuid::nil(),
            "method": "health",
            "body": {}
        }),
    ] {
        assert!(parse_json_strict::<AdapterRequest>(rejected.to_string().as_bytes()).is_err());
    }
}

fn write_private(path: &Path, contents: impl AsRef<[u8]>) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn sha256(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

fn write_regular(path: &Path, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
}

fn write_checksum_manifest(root: &Path, relative_paths: &[String]) {
    let mut paths = relative_paths.to_vec();
    paths.sort();
    let contents = paths
        .iter()
        .map(|path| format!("{}  {path}\n", sha256(&fs::read(root.join(path)).unwrap())))
        .collect::<String>();
    write_regular(&root.join("SHA256SUMS"), contents);
}

fn installed_health_fixture(root: &Path) -> (PathBuf, String) {
    let generation_name = format!("host-{}", "a".repeat(64));
    let generation = root.join("generations").join(&generation_name);
    let protocol = generation.join("protocol/codex-app-server");
    let mut inventory = [
        "v1/InitializeResponse.json",
        "v2/ThreadStartResponse.json",
        "v2/TurnStartResponse.json",
        "v2/ThreadStartedNotification.json",
        "v2/TurnStartedNotification.json",
        "v2/ItemStartedNotification.json",
        "v2/ItemCompletedNotification.json",
        "v2/TurnCompletedNotification.json",
        "v2/ThreadTokenUsageUpdatedNotification.json",
        "v2/AgentMessageDeltaNotification.json",
        "v2/ReasoningSummaryPartAddedNotification.json",
        "v2/ReasoningSummaryTextDeltaNotification.json",
        "v2/ReasoningTextDeltaNotification.json",
    ]
    .map(str::to_owned)
    .to_vec();
    inventory.sort();
    let mut schema_digest = Sha256::new();
    for path in &inventory {
        let raw = b"true";
        write_regular(&protocol.join(path), raw);
        schema_digest.update(b"host/browser-runtime/protocol/codex-app-server/");
        schema_digest.update(path.as_bytes());
        schema_digest.update([0]);
        schema_digest.update(raw);
        schema_digest.update([0]);
    }
    let schema_digest = format!("{:x}", schema_digest.finalize());
    let identity = json!({
        "executablePath": "/usr/local/bin/codex",
        "resolvedPath": "/opt/codex/bin/codex.js",
        "device": "1",
        "inode": "2",
        "version": "0.145.0"
    });
    write_regular(
        &protocol.join("manifest.json"),
        serde_json::to_vec(&json!({
            "formatVersion": 1,
            "codexIdentity": identity,
            "schemaInventory": inventory,
            "schemaDigest": schema_digest
        }))
        .unwrap(),
    );
    write_regular(
        &protocol.join("model-decision-envelope-v1.schema.json"),
        include_bytes!(
            "../../../host/browser-runtime/protocol/model-decision-envelope-v1.schema.json"
        ),
    );
    let mut protocol_sums = inventory.clone();
    protocol_sums.push("model-decision-envelope-v1.schema.json".to_owned());
    write_checksum_manifest(&protocol, &protocol_sums);
    write_regular(
        &generation.join("protocol/sandbox-broker-v1.contract.json"),
        include_bytes!("../../../host/browser-runtime/protocol/sandbox-broker-v1.contract.json"),
    );

    let artifact = b"codex-artifact";
    write_regular(&generation.join("codex-app-server.tar"), artifact);
    let mut binary_hashes = serde_json::Map::new();
    for name in [
        "acceptance-restart-broker",
        "firecrawl-browser-execution-adapter",
        "firecrawl-sandbox-broker",
    ] {
        let raw = format!("binary-{name}");
        write_regular(&generation.join("bin").join(name), raw.as_bytes());
        binary_hashes.insert(name.to_owned(), Value::String(sha256(raw.as_bytes())));
    }
    let mut policy_hashes = serde_json::Map::new();
    for name in ["bundles.json", "code-seccomp.json", "codex-seccomp.json"] {
        let raw = format!("policy-{name}");
        write_regular(&generation.join("policy").join(name), raw.as_bytes());
        policy_hashes.insert(name.to_owned(), Value::String(sha256(raw.as_bytes())));
    }
    let code_digest = "b".repeat(64);
    let codex_digest = "c".repeat(64);
    for (bundle, digest) in [
        ("code-v1", code_digest.as_str()),
        ("codex-v1", codex_digest.as_str()),
    ] {
        write_regular(
            &generation
                .join("bundles")
                .join(bundle)
                .join("rootfs.identity.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "bundleId": bundle,
                "rootfsSha256": digest
            }))
            .unwrap(),
        );
    }
    let timestamp = "2026-07-27T00:00:00.000Z";
    write_regular(
        &generation.join("manifest.json"),
        serde_json::to_vec(&json!({
            "formatVersion": 1,
            "buildTimestamp": timestamp,
            "codexAppServer": {
                "formatVersion": 1,
                "sourceIdentity": identity,
                "artifactSha256": sha256(artifact),
                "protocolSha256": schema_digest,
                "featureSha256": "d".repeat(64),
                "gateAttestationSha256": "e".repeat(64),
                "model": "gpt-5.6-terra",
                "reasoningEffort": "medium",
                "buildTimestamp": timestamp
            },
            "codeRuntime": {
                "node": "22.22.1",
                "python": "3.12.3",
                "bash": "5.2.21",
                "javascriptPlaywright": "1.61.1",
                "pythonPlaywright": "1.61.0",
                "relayProtocol": "code-relay-v1"
            },
            "bundleDigests": {
                "code-v1": code_digest,
                "codex-v1": codex_digest
            },
            "policyHashes": policy_hashes,
            "brokerContractSha256":
                firecrawl_browser_execution_adapter::broker_client::BROKER_CONTRACT_SHA256,
            "binaryHashes": binary_hashes
        }))
        .unwrap(),
    );
    fn collect(root: &Path, current: &Path, files: &mut Vec<String>) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                collect(root, &entry.path(), files);
            } else {
                files.push(
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_owned(),
                );
            }
        }
    }
    let mut generation_files = Vec::new();
    collect(&generation, &generation, &mut generation_files);
    write_checksum_manifest(&generation, &generation_files);
    fs::set_permissions(
        generation.parent().unwrap(),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::set_permissions(&generation, fs::Permissions::from_mode(0o755)).unwrap();
    symlink(
        format!("generations/{generation_name}"),
        root.join("current"),
    )
    .unwrap();
    symlink("current/protocol", root.join("protocol")).unwrap();
    (root.join("protocol/codex-app-server"), schema_digest)
}

fn synthetic_bundle() -> ProtocolBundle {
    let mut schemas = BTreeMap::new();
    for path in [
        "v1/InitializeResponse.json",
        "v2/ThreadStartResponse.json",
        "v2/TurnStartResponse.json",
        "v2/ThreadStartedNotification.json",
        "v2/TurnStartedNotification.json",
        "v2/ItemStartedNotification.json",
        "v2/ItemCompletedNotification.json",
        "v2/TurnCompletedNotification.json",
        "v2/ThreadTokenUsageUpdatedNotification.json",
        "v2/AgentMessageDeltaNotification.json",
        "v2/ReasoningSummaryPartAddedNotification.json",
        "v2/ReasoningSummaryTextDeltaNotification.json",
        "v2/ReasoningTextDeltaNotification.json",
    ] {
        schemas.insert(path.to_owned(), Value::Bool(true));
    }
    ProtocolBundle::synthetic(schemas).unwrap()
}

fn authorization_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../host/browser-runtime/protocol/execution-adapter-authorization-v1.fixture.json"
    ))
    .unwrap()
}

fn send_packet(fd: RawFd, value: Value) {
    let frame = value.to_string();
    send(fd, frame.as_bytes(), MsgFlags::empty()).unwrap();
}

fn send_packet_with_fd(fd: RawFd, value: Value, descriptor: RawFd) {
    send_packet_with_fds(fd, value, &[descriptor]);
}

fn send_packet_with_fds(fd: RawFd, value: Value, descriptors: &[RawFd]) {
    let frame = value.to_string();
    let iov = [IoSlice::new(frame.as_bytes())];
    if descriptors.is_empty() {
        sendmsg::<()>(fd, &iov, &[], MsgFlags::empty(), None).unwrap();
    } else {
        let control = [ControlMessage::ScmRights(descriptors)];
        sendmsg::<()>(fd, &iov, &control, MsgFlags::empty(), None).unwrap();
    }
}

fn receive_packet(fd: RawFd) -> Value {
    let mut buffer = [0_u8; 65_537];
    let read = recv(fd, &mut buffer, MsgFlags::empty()).unwrap();
    serde_json::from_slice(&buffer[..read]).unwrap()
}

fn receive_prepare(fd: RawFd) -> (Value, Vec<OwnedFd>) {
    let mut buffer = [0_u8; 65_537];
    let mut iov = [IoSliceMut::new(&mut buffer)];
    let mut control = cmsg_space!([RawFd; 5]);
    let message = recvmsg::<()>(fd, &mut iov, Some(&mut control), MsgFlags::empty()).unwrap();
    assert!(
        !message
            .flags
            .intersects(MsgFlags::MSG_TRUNC | MsgFlags::MSG_CTRUNC)
    );
    let bytes = message.bytes;
    let descriptors = message
        .cmsgs()
        .unwrap()
        .flat_map(|message| match message {
            ControlMessageOwned::ScmRights(descriptors) => descriptors,
            _ => Vec::new(),
        })
        .map(|descriptor| unsafe { OwnedFd::from_raw_fd(descriptor) })
        .collect();
    (
        serde_json::from_slice(&buffer[..bytes]).unwrap(),
        descriptors,
    )
}

fn receive_fresh_cancel(listener: RawFd, prepare: &Value, events: &Arc<Mutex<Vec<String>>>) {
    let connection = accept(listener).unwrap();
    let cancel = receive_packet(connection);
    assert_eq!(cancel["method"], "cancel");
    assert_eq!(cancel["job_id"], prepare["job_id"]);
    assert_eq!(cancel["adapter_boot_id"], prepare["adapter_boot_id"]);
    events.lock().unwrap().push("cancel".to_owned());
    send_packet(
        connection,
        json!({
            "type": "terminal",
            "job_id": prepare["job_id"],
            "init_pid": INIT_PID,
            "outcome": if cancel["reason"] == "timed_out" {
                "timed_out"
            } else {
                "cancelled"
            },
            "artifacts": []
        }),
    );
}

fn run_fake_broker(
    socket_path: PathBuf,
    events: Arc<Mutex<Vec<String>>>,
    prepared_tx: mpsc::Sender<()>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, mut descriptors) = receive_prepare(connection);
        assert_eq!(prepare["method"], "prepare");
        assert_eq!(prepare["bundle_id"], "codex-v1");
        assert!(Uuid::parse_str(prepare["adapter_boot_id"].as_str().unwrap()).is_ok());
        assert!(Uuid::parse_str(prepare["correlation_id"].as_str().unwrap()).is_ok());
        assert_eq!(descriptors.len(), 5);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared".to_owned());
        prepared_tx.send(()).unwrap();

        let start = receive_packet(connection);
        assert_eq!(
            start,
            json!({
                "method": "start",
                "job_id": prepare["job_id"],
                "expected_init_pid": INIT_PID
            })
        );
        events.lock().unwrap().push("start".to_owned());
        send_packet(
            connection,
            json!({
                "type": "started",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("started".to_owned());

        let child_stdin = descriptors.remove(0);
        let child_stdout = descriptors.remove(0);
        let _child_stderr = descriptors.remove(0);
        let mut stdin = StdBufReader::new(fs::File::from(child_stdin));
        let mut stdout = fs::File::from(child_stdout);
        let mut line = String::new();
        stdin.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["method"],
            "initialize"
        );
        writeln!(
            stdout,
            "{}",
            json!({"id":1,"result":{
                "codexHome":"/run/firecrawl-codex",
                "platformFamily":"unix",
                "platformOs":"linux",
                "userAgent":"fixture"
            }})
        )
        .unwrap();
        stdout.flush().unwrap();
        line.clear();
        stdin.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["method"],
            "initialized"
        );
        line.clear();
        stdin.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["method"],
            "thread/start"
        );
        writeln!(
            stdout,
            "{}",
            json!({"id":2,"result":{"thread":{"id":"thread-1"}}})
        )
        .unwrap();
        stdout.flush().unwrap();
        line.clear();
        stdin.read_line(&mut line).unwrap();
        let turn = serde_json::from_str::<Value>(&line).unwrap();
        assert_eq!(turn["method"], "turn/start");
        writeln!(
            stdout,
            "{}",
            json!({"id":3,"result":{"turn":{"id":
                "01985f6d-9c40-7000-8000-000000000001"}}})
        )
        .unwrap();
        writeln!(
            stdout,
            "{}",
            json!({"method":"item/completed","params":{
                "threadId":"thread-1",
                "turnId":"01985f6d-9c40-7000-8000-000000000001",
                "completedAtMs":1_750_000_001_000_i64,
                "item":{
                    "id":"agent-1",
                    "type":"agentMessage",
                    "text":"{\"decision\":{\"version\":1,\"type\":\"final\",\"output\":\"done\"}}"
                }
            }})
        )
        .unwrap();
        writeln!(
            stdout,
            "{}",
            json!({"method":"turn/completed","params":{
                "threadId":"thread-1",
                "turn":{
                    "id":"01985f6d-9c40-7000-8000-000000000001",
                    "status":"completed",
                    "items":[],
                    "itemsView":"notLoaded",
                    "startedAt":1_750_000_000_i64,
                    "completedAt":1_750_000_001_i64,
                    "durationMs":1000_i64,
                    "error":null
                }
            }})
        )
        .unwrap();
        stdout.flush().unwrap();
        let cancel = receive_packet(connection);
        assert_eq!(cancel["method"], "cancel");
        assert_eq!(cancel["job_id"], prepare["job_id"]);
        assert_eq!(cancel["adapter_boot_id"], prepare["adapter_boot_id"]);
        events.lock().unwrap().push("cancel".to_owned());
        send_packet(
            connection,
            json!({
                "type":"terminal",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID,
                "outcome":"completed",
                "artifacts":[]
            }),
        );
    })
}

#[derive(Clone, Copy)]
enum PrestartFailure {
    ApiEof,
    MismatchedAuthorization,
    DuplicateAuthorization,
    AuthorizationTimeout,
    AuthorizationWithoutEof,
    StartedPidMismatch,
}

#[derive(Clone, Copy)]
enum PoststartFailure {
    Protocol,
    Deadline,
}

impl PrestartFailure {
    fn expects_start(self) -> bool {
        matches!(self, Self::StartedPidMismatch)
    }
}

fn run_prestart_failure_broker(
    socket_path: PathBuf,
    expects_start: bool,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, descriptors) = receive_prepare(connection);
        assert_eq!(descriptors.len(), 5);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared".to_owned());
        if expects_start {
            let start = receive_packet(connection);
            assert_eq!(start["method"], "start");
            events.lock().unwrap().push("start".to_owned());
            send_packet(
                connection,
                json!({
                    "type": "started",
                    "job_id": prepare["job_id"],
                    "init_pid": INIT_PID + 1
                }),
            );
        }
        drop(descriptors);
        if expects_start {
            nix::unistd::close(connection).unwrap();
        }
        receive_fresh_cancel(listener.as_raw_fd(), &prepare, &events);
        if !expects_start {
            nix::unistd::close(connection).unwrap();
        }
    })
}

fn run_unproven_prompt_cleanup_broker(
    socket_path: PathBuf,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, descriptors) = receive_prepare(connection);
        assert_eq!(descriptors.len(), 5);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared".to_owned());

        let cancellation = accept(listener.as_raw_fd()).unwrap();
        let cancel = receive_packet(cancellation);
        assert_eq!(cancel["method"], "cancel");
        assert_eq!(cancel["job_id"], prepare["job_id"]);
        assert_eq!(cancel["adapter_boot_id"], prepare["adapter_boot_id"]);
        events.lock().unwrap().push("cancel_unproven".to_owned());
        nix::unistd::close(cancellation).unwrap();
        nix::unistd::close(connection).unwrap();
    })
}

fn run_lease_failure_broker(
    socket_path: PathBuf,
    send_error: bool,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, descriptors) = receive_prepare(connection);
        assert_eq!(descriptors.len(), 5);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared".to_owned());
        if send_error {
            send_packet(
                connection,
                json!({
                    "type": "error",
                    "category": "lease_failed",
                    "message": "prepared lease failed"
                }),
            );
            events.lock().unwrap().push("lease_error".to_owned());
        } else {
            events.lock().unwrap().push("lease_eof".to_owned());
        }
        nix::unistd::close(connection).unwrap();
        receive_fresh_cancel(listener.as_raw_fd(), &prepare, &events);
    })
}

fn run_delayed_prepare_broker(
    socket_path: PathBuf,
    prepared_request_tx: mpsc::Sender<()>,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, descriptors) = receive_prepare(connection);
        assert_eq!(descriptors.len(), 5);
        events.lock().unwrap().push("prepare".to_owned());
        prepared_request_tx.send(()).unwrap();
        let mut packet = [0_u8; 64];
        assert_eq!(recv(connection, &mut packet, MsgFlags::empty()).unwrap(), 0);
        nix::unistd::close(connection).unwrap();
        receive_fresh_cancel(listener.as_raw_fd(), &prepare, &events);
    })
}

fn run_poststart_failure_broker(
    socket_path: PathBuf,
    failure: PoststartFailure,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, mut descriptors) = receive_prepare(connection);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared".to_owned());
        let start = receive_packet(connection);
        assert_eq!(start["method"], "start");
        events.lock().unwrap().push("start".to_owned());
        send_packet(
            connection,
            json!({
                "type": "started",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("started".to_owned());

        let _child_stdin = descriptors.remove(0);
        let child_stdout = descriptors.remove(0);
        let _child_stderr = descriptors.remove(0);
        let mut stdout = fs::File::from(child_stdout);
        if matches!(failure, PoststartFailure::Protocol) {
            writeln!(stdout, "{{not-json}}").unwrap();
            stdout.flush().unwrap();
        }

        let cancel = receive_packet(connection);
        assert_eq!(cancel["method"], "cancel");
        assert_eq!(cancel["job_id"], prepare["job_id"]);
        events.lock().unwrap().push("cancel".to_owned());
        drop(stdout);
        send_packet(
            connection,
            json!({
                "type": "terminal",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID,
                "outcome": if matches!(failure, PoststartFailure::Protocol) {
                    "failed"
                } else {
                    "timed_out"
                },
                "artifacts": []
            }),
        );
    })
}

fn run_stalled_start_broker(
    socket_path: PathBuf,
    start_tx: mpsc::Sender<()>,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, descriptors) = receive_prepare(connection);
        assert_eq!(descriptors.len(), 5);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared".to_owned());
        let start = receive_packet(connection);
        assert_eq!(start["method"], "start");
        events.lock().unwrap().push("start".to_owned());
        start_tx.send(()).unwrap();
        let mut packet = [0_u8; 64];
        assert_eq!(recv(connection, &mut packet, MsgFlags::empty()).unwrap(), 0);
        events.lock().unwrap().push("lease_eof".to_owned());
        nix::unistd::close(connection).unwrap();
        receive_fresh_cancel(listener.as_raw_fd(), &prepare, &events);
    })
}

fn run_prepared_response_fd_broker(
    socket_path: PathBuf,
    events: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, descriptors) = receive_prepare(connection);
        events.lock().unwrap().push("prepare".to_owned());
        send_packet_with_fd(
            connection,
            json!({
                "type": "prepared",
                "job_id": prepare["job_id"],
                "init_pid": INIT_PID
            }),
            descriptors[0].as_raw_fd(),
        );
        events.lock().unwrap().push("prepared_with_fd".to_owned());
        let mut packet = [0_u8; 64];
        assert_eq!(recv(connection, &mut packet, MsgFlags::empty()).unwrap(), 0);
        events.lock().unwrap().push("lease_eof".to_owned());
        nix::unistd::close(connection).unwrap();
        receive_fresh_cancel(listener.as_raw_fd(), &prepare, &events);
    })
}

fn run_prior_owner_broker(
    socket_path: PathBuf,
    prior_boot_id: Uuid,
    received: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(4).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        assert_eq!(
            receive_packet(connection),
            json!({"method":"cancel_owner","adapter_boot_id":prior_boot_id})
        );
        received.send(()).unwrap();
        release.recv().unwrap();
        send_packet(connection, json!({"type":"owner_cancelled"}));
    })
}

fn run_diagnose_broker(
    socket_path: PathBuf,
    returned_correlation_id: Uuid,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(1).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let request = receive_packet(connection);
        assert_eq!(request["method"], "diagnose");
        send_packet(
            connection,
            json!({
                "type": "diagnostic",
                "correlation_id": returned_correlation_id,
                "job_id": request["job_id"],
                "phase": "prepared",
                "init_pid": INIT_PID,
                "pidfd_live": true,
                "pidfd_pid_matches": true,
                "control_lease_connected": true,
                "inert_relay_fd_present": false,
                "relay_listener_present": false,
                "cdp_relay_opened": false,
                "payload_marker_present": false,
                "runc_state": "created",
                "cgroup_present": true,
                "job_directory_present": true,
                "child_count": 1,
                "cleanup_failure": false
            }),
        );
    })
}

fn run_not_found_diagnose_broker(socket_path: PathBuf) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(1).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        assert_eq!(receive_packet(connection)["method"], "diagnose");
        send_packet(
            connection,
            json!({
                "type": "error",
                "category": "unauthorized",
                "message": "peer rejected"
            }),
        );
    })
}

fn run_health_broker(socket_path: PathBuf) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(1).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        assert_eq!(receive_packet(connection), json!({"method": "health"}));
        send_packet(connection, json!({"type": "healthy"}));
    })
}

fn run_status_broker(socket_path: PathBuf, response: Option<Value>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&socket_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(1).unwrap()).unwrap();
        let connection = unsafe { OwnedFd::from_raw_fd(accept(listener.as_raw_fd()).unwrap()) };
        assert_eq!(
            receive_packet(connection.as_raw_fd()),
            json!({"method": "status"})
        );
        if let Some(response) = response {
            send_packet(connection.as_raw_fd(), response);
        }
    })
}

async fn read_json_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Value {
    let mut line = String::new();
    assert!(reader.read_line(&mut line).await.unwrap() > 0);
    serde_json::from_str(&line).unwrap()
}

fn deadline_iso() -> String {
    deadline_iso_after(30_000)
}

fn deadline_iso_after(offset_ms: i64) -> String {
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + offset_ms;
    let seconds = unix_ms / 1000;
    let milliseconds = unix_ms % 1000;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milliseconds:03}Z",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60,
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn prompt_request(request_id: Uuid, run_id: Uuid, deadline: String) -> Value {
    json!({
        "version":1,
        "requestId":request_id,
        "method":"execute_prompt",
        "body":{
            "adapterJobId":Uuid::new_v4(),
            "adapterSupervisorId":Uuid::new_v4(),
            "capabilityToken":"x".repeat(43),
            "runId":run_id,
            "prompt":"finish",
            "initialObservation":{
                "version":1,
                "type":"initial",
                "sequence":0,
                "page":{
                    "url":"https://example.test/",
                    "title":"Fixture",
                    "snapshotExcerpt":"ready"
                }
            },
            "model":"gpt-5.6-terra",
            "reasoningEffort":"medium",
            "decisionSchemaVersion":1,
            "observationSchemaVersion":1,
            "loopPolicy":{
                "maxPromptCharacters":10000,
                "maxSnapshotExcerptCharacters":40000,
                "maxObservationBytes":65536,
                "maxAggregateObservationBytes":1048576,
                "maxFinalOutputBytes":262144,
                "maxActions":25,
                "maxTurns":26,
                "maxRuntimeMs":300000
            },
            "deadline":deadline,
            "correlationId":Uuid::new_v4()
        }
    })
}

#[tokio::test]
async fn prepared_pid_is_accepted_before_same_connection_start() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let events = Arc::new(Mutex::new(Vec::new()));
    let (prepared_tx, prepared_rx) = mpsc::channel();
    let broker_thread = run_fake_broker(broker_path.clone(), events.clone(), prepared_tx);
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: "http://127.0.0.1:3002".to_owned(),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused-protocol"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        JobRegistry::new(1, 2).unwrap(),
        synthetic_bundle(),
    );
    let (api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    let fixture = authorization_fixture();
    let request_id = Uuid::parse_str(fixture["accepted"]["requestId"].as_str().unwrap()).unwrap();
    let adapter_job_id =
        Uuid::parse_str(fixture["binding"]["adapterJobId"].as_str().unwrap()).unwrap();
    let adapter_supervisor_id =
        Uuid::parse_str(fixture["binding"]["adapterSupervisorId"].as_str().unwrap()).unwrap();
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "method":"execute_prompt",
                    "body":{
                        "adapterJobId":adapter_job_id,
                        "adapterSupervisorId":adapter_supervisor_id,
                        "capabilityToken":"x".repeat(43),
                        "runId":Uuid::new_v4(),
                        "prompt":"finish",
                        "initialObservation":{
                            "version":1,
                            "type":"initial",
                            "sequence":0,
                            "page":{
                                "url":"https://example.test/",
                                "title":"Fixture",
                                "snapshotExcerpt":"ready"
                            }
                        },
                        "model":"gpt-5.6-terra",
                        "reasoningEffort":"medium",
                        "decisionSchemaVersion":1,
                        "observationSchemaVersion":1,
                        "loopPolicy":{
                            "maxPromptCharacters":10000,
                            "maxSnapshotExcerptCharacters":40000,
                            "maxObservationBytes":65536,
                            "maxAggregateObservationBytes":1048576,
                            "maxFinalOutputBytes":262144,
                            "maxActions":25,
                            "maxTurns":26,
                            "maxRuntimeMs":300000
                        },
                        "deadline":deadline_iso(),
                        "correlationId":Uuid::new_v4()
                    }
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let accepted = read_json_line(&mut api_reader).await;
    assert_eq!(accepted, fixture["accepted"]);
    prepared_rx.recv_timeout(StdDuration::from_secs(1)).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(events.lock().unwrap().as_slice(), ["prepare", "prepared"]);
    api_writer
        .write_all(format!("{}\n", fixture["authorized"]).as_bytes())
        .await
        .unwrap();
    api_writer.shutdown().await.unwrap();
    let result = read_json_line(&mut api_reader).await;
    assert_eq!(result["type"], "result");
    assert_eq!(result["body"]["output"], "done");
    handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    assert_eq!(
        events.lock().unwrap().as_slice(),
        ["prepare", "prepared", "start", "started", "cancel"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn every_prestart_api_or_pid_failure_aborts_and_clears_registry() {
    for failure in [
        PrestartFailure::ApiEof,
        PrestartFailure::MismatchedAuthorization,
        PrestartFailure::DuplicateAuthorization,
        PrestartFailure::AuthorizationTimeout,
        PrestartFailure::AuthorizationWithoutEof,
        PrestartFailure::StartedPidMismatch,
    ] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let auth_path = root.join("auth.json");
        let token_path = root.join("adapter.token");
        write_private(&auth_path, "{}");
        write_private(&token_path, "x".repeat(43));
        let events = Arc::new(Mutex::new(Vec::new()));
        let broker_thread = run_prestart_failure_broker(
            broker_path.clone(),
            failure.expects_start(),
            events.clone(),
        );
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        };
        let registry = JobRegistry::new(1, 2).unwrap();
        let service = AdapterService::with_dependencies(
            config,
            BrokerClient::new(broker_path).unwrap(),
            registry.clone(),
            synthetic_bundle(),
        );
        let (api, adapter) = UnixStream::pair().unwrap();
        let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
        let (api_reader, mut api_writer) = api.into_split();
        let mut api_reader = BufReader::new(api_reader);
        let request_id = Uuid::new_v4();
        api_writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "version":1,
                        "requestId":request_id,
                        "method":"execute_prompt",
                        "body":{
                            "adapterJobId":Uuid::new_v4(),
                            "adapterSupervisorId":Uuid::new_v4(),
                            "capabilityToken":"x".repeat(43),
                            "runId":Uuid::new_v4(),
                            "prompt":"finish",
                            "initialObservation":{
                                "version":1,
                                "type":"initial",
                                "sequence":0,
                                "page":{
                                    "url":"https://example.test/",
                                    "title":"Fixture",
                                    "snapshotExcerpt":"ready"
                                }
                            },
                            "model":"gpt-5.6-terra",
                            "reasoningEffort":"medium",
                            "decisionSchemaVersion":1,
                            "observationSchemaVersion":1,
                            "loopPolicy":{
                                "maxPromptCharacters":10000,
                                "maxSnapshotExcerptCharacters":40000,
                                "maxObservationBytes":65536,
                                "maxAggregateObservationBytes":1048576,
                                "maxFinalOutputBytes":262144,
                                "maxActions":25,
                                "maxTurns":26,
                                "maxRuntimeMs":300000
                            },
                            "deadline":deadline_iso_after(
                                if matches!(
                                    failure,
                                    PrestartFailure::AuthorizationTimeout
                                        | PrestartFailure::AuthorizationWithoutEof
                                ) {
                                    100
                                } else {
                                    30_000
                                }
                            ),
                            "correlationId":Uuid::new_v4()
                        }
                    })
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let accepted = read_json_line(&mut api_reader).await;
        assert_eq!(accepted["type"], "accepted");
        let acknowledgement = json!({
            "version":1,
            "requestId":request_id,
            "type":"authorized",
            "binding":accepted["binding"]
        });
        match failure {
            PrestartFailure::ApiEof => drop(api_writer),
            PrestartFailure::MismatchedAuthorization => {
                let mut mismatched = acknowledgement;
                mismatched["binding"]["adapterProcessId"] = json!(INIT_PID + 1);
                api_writer
                    .write_all(format!("{mismatched}\n").as_bytes())
                    .await
                    .unwrap();
                api_writer.shutdown().await.unwrap();
            }
            PrestartFailure::DuplicateAuthorization => {
                api_writer
                    .write_all(format!("{acknowledgement}\n{acknowledgement}\n").as_bytes())
                    .await
                    .unwrap();
                api_writer.shutdown().await.unwrap();
            }
            PrestartFailure::AuthorizationTimeout => {}
            PrestartFailure::AuthorizationWithoutEof => {
                api_writer
                    .write_all(format!("{acknowledgement}\n").as_bytes())
                    .await
                    .unwrap();
            }
            PrestartFailure::StartedPidMismatch => {
                api_writer
                    .write_all(format!("{acknowledgement}\n").as_bytes())
                    .await
                    .unwrap();
                api_writer.shutdown().await.unwrap();
            }
        }
        handler.await.unwrap().unwrap();
        assert_eq!(read_json_line(&mut api_reader).await["type"], "error");
        broker_thread.join().unwrap();
        assert_eq!(registry.active_count(), 0);
        let expected = if failure.expects_start() {
            vec!["prepare", "prepared", "start", "cancel"]
        } else {
            vec!["prepare", "prepared", "cancel"]
        };
        assert_eq!(*events.lock().unwrap(), expected);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn prepared_lease_eof_or_error_prevents_authorization_and_start() {
    for send_error in [false, true] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let auth_path = root.join("auth.json");
        let token_path = root.join("adapter.token");
        write_private(&auth_path, "{}");
        write_private(&token_path, "x".repeat(43));
        let events = Arc::new(Mutex::new(Vec::new()));
        let broker_thread =
            run_lease_failure_broker(broker_path.clone(), send_error, events.clone());
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        };
        let registry = JobRegistry::new(1, 2).unwrap();
        let service = AdapterService::with_dependencies(
            config,
            BrokerClient::new(broker_path).unwrap(),
            registry.clone(),
            synthetic_bundle(),
        );
        let (api, adapter) = UnixStream::pair().unwrap();
        let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
        let (api_reader, mut api_writer) = api.into_split();
        let mut api_reader = BufReader::new(api_reader);
        api_writer
            .write_all(
                format!(
                    "{}\n",
                    prompt_request(Uuid::new_v4(), Uuid::new_v4(), deadline_iso())
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        assert_eq!(read_json_line(&mut api_reader).await["type"], "accepted");
        let error = read_json_line(&mut api_reader).await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["error"]["category"], "sandbox_unavailable");
        handler.await.unwrap().unwrap();
        broker_thread.join().unwrap();
        assert_eq!(registry.active_count(), 0);
        assert_eq!(
            *events.lock().unwrap(),
            if send_error {
                vec!["prepare", "prepared", "lease_error", "cancel"]
            } else {
                vec!["prepare", "prepared", "lease_eof", "cancel"]
            }
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn callback_credential_failure_aborts_before_accept_or_start() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    fs::write(&token_path, "x".repeat(43)).unwrap();
    fs::set_permissions(&token_path, fs::Permissions::from_mode(0o640)).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_prestart_failure_broker(broker_path.clone(), false, events.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: "http://127.0.0.1:3002".to_owned(),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused-protocol"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let registry = JobRegistry::new(1, 2).unwrap();
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        registry.clone(),
        synthetic_bundle(),
    );
    let (api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(
            format!(
                "{}\n",
                prompt_request(Uuid::new_v4(), Uuid::new_v4(), deadline_iso())
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let error = read_json_line(&mut api_reader).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["category"], "capability_denied");
    handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(
        *events.lock().unwrap(),
        vec!["prepare", "prepared", "cancel"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn cancellation_before_authorization_aborts_once_and_unblocks_cancel_request() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_prestart_failure_broker(broker_path.clone(), false, events.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: "http://127.0.0.1:3002".to_owned(),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused-protocol"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let registry = JobRegistry::new(1, 2).unwrap();
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        registry.clone(),
        synthetic_bundle(),
    );
    let run_id = Uuid::new_v4();
    let request_id = Uuid::new_v4();
    let (api, adapter) = UnixStream::pair().unwrap();
    let prompt_service = service.clone();
    let prompt_handler =
        tokio::spawn(async move { prompt_service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(format!("{}\n", prompt_request(request_id, run_id, deadline_iso())).as_bytes())
        .await
        .unwrap();
    assert_eq!(read_json_line(&mut api_reader).await["type"], "accepted");

    let (cancel_api, cancel_adapter) = UnixStream::pair().unwrap();
    let cancel_handler =
        tokio::spawn(async move { service.handle_connection(cancel_adapter).await });
    let (cancel_reader, mut cancel_writer) = cancel_api.into_split();
    let mut cancel_reader = BufReader::new(cancel_reader);
    let cancel_request_id = Uuid::new_v4();
    cancel_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":cancel_request_id,
                    "method":"cancel",
                    "body":{"runId":run_id,"reason":"api_cancelled"}
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let cancelled = read_json_line(&mut cancel_reader).await;
    assert_eq!(cancelled["type"], "result");
    assert_eq!(cancelled["body"]["killed"], true);
    let prompt_error = read_json_line(&mut api_reader).await;
    assert_eq!(prompt_error["type"], "error");
    assert_eq!(prompt_error["error"]["category"], "cancelled");
    prompt_handler.await.unwrap().unwrap();
    cancel_handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(
        *events.lock().unwrap(),
        vec!["prepare", "prepared", "cancel"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn unproven_prompt_cleanup_returns_cancel_error_and_fail_stops_prompts() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_unproven_prompt_cleanup_broker(broker_path.clone(), events.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: "http://127.0.0.1:3002".to_owned(),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused-protocol"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let registry = JobRegistry::new(1, 2).unwrap();
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        registry.clone(),
        synthetic_bundle(),
    );
    let run_id = Uuid::new_v4();
    let request_id = Uuid::new_v4();
    let (api, adapter) = UnixStream::pair().unwrap();
    let prompt_service = service.clone();
    let prompt_handler =
        tokio::spawn(async move { prompt_service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(format!("{}\n", prompt_request(request_id, run_id, deadline_iso())).as_bytes())
        .await
        .unwrap();
    assert_eq!(read_json_line(&mut api_reader).await["type"], "accepted");

    let (cancel_api, cancel_adapter) = UnixStream::pair().unwrap();
    let cancel_service = service.clone();
    let cancel_handler =
        tokio::spawn(async move { cancel_service.handle_connection(cancel_adapter).await });
    let (cancel_reader, mut cancel_writer) = cancel_api.into_split();
    let mut cancel_reader = BufReader::new(cancel_reader);
    cancel_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version": 1,
                    "requestId": Uuid::new_v4(),
                    "method": "cancel",
                    "body": {"runId": run_id, "reason": "api_cancelled"}
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let cancel_error = read_json_line(&mut cancel_reader).await;
    assert_eq!(cancel_error["type"], "error");
    assert_eq!(cancel_error["error"]["category"], "sandbox_unavailable");
    cancel_handler.await.unwrap().unwrap();
    let prompt_error = read_json_line(&mut api_reader).await;
    assert_eq!(prompt_error["type"], "error");
    assert_eq!(prompt_error["error"]["category"], "sandbox_unavailable");
    prompt_handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(
        *events.lock().unwrap(),
        vec!["prepare", "prepared", "cancel_unproven"]
    );

    let (second_api, second_adapter) = UnixStream::pair().unwrap();
    let second_handler =
        tokio::spawn(async move { service.handle_connection(second_adapter).await });
    let (second_reader, mut second_writer) = second_api.into_split();
    let mut second_reader = BufReader::new(second_reader);
    second_writer
        .write_all(
            format!(
                "{}\n",
                prompt_request(Uuid::new_v4(), Uuid::new_v4(), deadline_iso())
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let second_error = read_json_line(&mut second_reader).await;
    assert_eq!(second_error["type"], "error");
    assert_eq!(second_error["error"]["category"], "codex_unavailable");
    second_handler.await.unwrap().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn cancellation_during_prepare_aborts_once_and_releases_reserved_capacity() {
    for cancelled in [true, false] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let auth_path = root.join("auth.json");
        let token_path = root.join("adapter.token");
        write_private(&auth_path, "{}");
        write_private(&token_path, "x".repeat(43));
        let events = Arc::new(Mutex::new(Vec::new()));
        let (prepare_tx, prepare_rx) = mpsc::channel();
        let broker_thread =
            run_delayed_prepare_broker(broker_path.clone(), prepare_tx, events.clone());
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        };
        let registry = JobRegistry::new(1, 2).unwrap();
        let service = AdapterService::with_dependencies(
            config,
            BrokerClient::new(broker_path).unwrap(),
            registry.clone(),
            synthetic_bundle(),
        );
        let run_id = Uuid::new_v4();
        let (prompt_api, prompt_adapter) = UnixStream::pair().unwrap();
        let prompt_service = service.clone();
        let prompt_handler =
            tokio::spawn(async move { prompt_service.handle_connection(prompt_adapter).await });
        let (prompt_reader, mut prompt_writer) = prompt_api.into_split();
        let mut prompt_reader = BufReader::new(prompt_reader);
        prompt_writer
            .write_all(
                format!(
                    "{}\n",
                    prompt_request(
                        Uuid::new_v4(),
                        run_id,
                        deadline_iso_after(if cancelled { 30_000 } else { 100 })
                    )
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        tokio::task::spawn_blocking(move || {
            prepare_rx.recv_timeout(StdDuration::from_secs(1)).unwrap()
        })
        .await
        .unwrap();

        let mut completion = if cancelled {
            Some(registry.request_cancel(run_id).unwrap())
        } else {
            None
        };
        let prompt_error = read_json_line(&mut prompt_reader).await;
        assert_eq!(
            prompt_error["error"]["category"],
            if cancelled { "cancelled" } else { "timed_out" }
        );
        prompt_handler.await.unwrap().unwrap();
        if let Some(completion) = completion.as_mut() {
            if *completion.borrow() == JobCompletion::Pending {
                completion.changed().await.unwrap();
            }
            assert_eq!(*completion.borrow(), JobCompletion::Proven);
        }
        broker_thread.join().unwrap();
        assert_eq!(registry.active_count(), 0);
        assert_eq!(*events.lock().unwrap(), vec!["prepare", "cancel"]);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn post_started_protocol_or_deadline_failure_finishes_exactly_once() {
    for failure in [PoststartFailure::Protocol, PoststartFailure::Deadline] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let auth_path = root.join("auth.json");
        let token_path = root.join("adapter.token");
        write_private(&auth_path, "{}");
        write_private(&token_path, "x".repeat(43));
        let events = Arc::new(Mutex::new(Vec::new()));
        let broker_thread =
            run_poststart_failure_broker(broker_path.clone(), failure, events.clone());
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        };
        let registry = JobRegistry::new(1, 2).unwrap();
        let service = AdapterService::with_dependencies(
            config,
            BrokerClient::new(broker_path).unwrap(),
            registry.clone(),
            synthetic_bundle(),
        );
        let (api, adapter) = UnixStream::pair().unwrap();
        let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
        let (api_reader, mut api_writer) = api.into_split();
        let mut api_reader = BufReader::new(api_reader);
        let request_id = Uuid::new_v4();
        let deadline = deadline_iso_after(if matches!(failure, PoststartFailure::Deadline) {
            100
        } else {
            30_000
        });
        api_writer
            .write_all(
                format!("{}\n", prompt_request(request_id, Uuid::new_v4(), deadline)).as_bytes(),
            )
            .await
            .unwrap();
        let accepted = read_json_line(&mut api_reader).await;
        assert_eq!(accepted["type"], "accepted");
        api_writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "version": 1,
                        "requestId": request_id,
                        "type": "authorized",
                        "binding": accepted["binding"]
                    })
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        api_writer.shutdown().await.unwrap();
        let terminal = read_json_line(&mut api_reader).await;
        assert_eq!(terminal["type"], "error");
        assert_eq!(
            terminal["error"]["category"],
            if matches!(failure, PoststartFailure::Protocol) {
                "model_protocol_error"
            } else {
                "timed_out"
            }
        );
        handler.await.unwrap().unwrap();
        broker_thread.join().unwrap();
        assert_eq!(registry.active_count(), 0);
        assert_eq!(registry.terminal_jobs().len(), 1);
        assert_eq!(
            *events.lock().unwrap(),
            vec!["prepare", "prepared", "start", "started", "cancel"]
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn stalled_start_cancel_or_deadline_closes_lease_once() {
    for cancelled in [true, false] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let auth_path = root.join("auth.json");
        let token_path = root.join("adapter.token");
        write_private(&auth_path, "{}");
        write_private(&token_path, "x".repeat(43));
        let events = Arc::new(Mutex::new(Vec::new()));
        let (start_tx, start_rx) = mpsc::channel();
        let broker_thread = run_stalled_start_broker(broker_path.clone(), start_tx, events.clone());
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        };
        let registry = JobRegistry::new(1, 2).unwrap();
        let service = AdapterService::with_dependencies(
            config,
            BrokerClient::new(broker_path).unwrap(),
            registry.clone(),
            synthetic_bundle(),
        );
        let run_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let (api, adapter) = UnixStream::pair().unwrap();
        let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
        let (api_reader, mut api_writer) = api.into_split();
        let mut api_reader = BufReader::new(api_reader);
        api_writer
            .write_all(
                format!(
                    "{}\n",
                    prompt_request(
                        request_id,
                        run_id,
                        deadline_iso_after(if cancelled { 30_000 } else { 500 })
                    )
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let accepted = read_json_line(&mut api_reader).await;
        api_writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "version": 1,
                        "requestId": request_id,
                        "type": "authorized",
                        "binding": accepted["binding"]
                    })
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        api_writer.shutdown().await.unwrap();
        tokio::task::spawn_blocking(move || {
            start_rx.recv_timeout(StdDuration::from_secs(1)).unwrap()
        })
        .await
        .unwrap();
        if cancelled {
            registry.request_cancel(run_id).unwrap();
        }
        let error = read_json_line(&mut api_reader).await;
        assert_eq!(
            error["error"]["category"],
            if cancelled { "cancelled" } else { "timed_out" }
        );
        handler.await.unwrap().unwrap();
        broker_thread.join().unwrap();
        assert_eq!(registry.active_count(), 0);
        assert_eq!(registry.terminal_jobs().len(), 1);
        assert_eq!(
            *events.lock().unwrap(),
            vec!["prepare", "prepared", "start", "lease_eof", "cancel"]
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn descriptor_on_prepared_response_is_rejected_before_start() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_prepared_response_fd_broker(broker_path.clone(), events.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: "http://127.0.0.1:3002".to_owned(),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused-protocol"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let registry = JobRegistry::new(1, 2).unwrap();
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        registry.clone(),
        synthetic_bundle(),
    );
    let (api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(
            format!(
                "{}\n",
                prompt_request(Uuid::new_v4(), Uuid::new_v4(), deadline_iso())
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let error = read_json_line(&mut api_reader).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["category"], "sandbox_unavailable");
    handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(
        *events.lock().unwrap(),
        vec!["prepare", "prepared_with_fd", "lease_eof", "cancel"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn prior_owner_cleanup_finishes_before_new_boot_publication_or_admission() {
    let root = temporary_root();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let broker_path = root.join("broker.sock");
    let adapter_path = root.join("adapter.sock");
    let boot_path = root.join("adapter.boot-id");
    let prior_boot_id = Uuid::new_v4();
    fs::write(&boot_path, format!("{prior_boot_id}\n")).unwrap();
    fs::set_permissions(&boot_path, fs::Permissions::from_mode(0o600)).unwrap();
    let (received_tx, received_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let broker_thread =
        run_prior_owner_broker(broker_path.clone(), prior_boot_id, received_tx, release_rx);
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let config = AdapterConfig {
        adapter_socket: adapter_path.clone(),
        broker_socket: broker_path.clone(),
        callback_url: "http://127.0.0.1:3002".to_owned(),
        callback_token_file: root.join("unused-token"),
        codex_auth_file: root.join("unused-auth"),
        protocol_root: root.join("unused-protocol"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        JobRegistry::new(1, 2).unwrap(),
        synthetic_bundle(),
    );
    let serve = tokio::spawn(service.serve());
    tokio::task::spawn_blocking(move || received_rx.recv_timeout(StdDuration::from_secs(1)))
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        fs::read_to_string(&boot_path).unwrap(),
        format!("{prior_boot_id}\n")
    );
    assert!(!adapter_path.exists());
    release_tx.send(()).unwrap();
    for _ in 0..1_000 {
        if adapter_path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    if serve.is_finished() {
        let result = serve.await.unwrap();
        panic!("adapter service exited before binding: {result:?}");
    }
    assert!(adapter_path.exists());
    let published = fs::read_to_string(&boot_path).unwrap();
    assert_ne!(published, format!("{prior_boot_id}\n"));
    assert!(!Uuid::parse_str(published.trim()).unwrap().is_nil());
    serve.abort();
    let _ = serve.await;
    broker_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn diagnose_round_trips_exact_correlation_and_state() {
    for mismatch in [false, true] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let correlation_id = Uuid::new_v4();
        let returned_correlation_id = if mismatch {
            Uuid::new_v4()
        } else {
            correlation_id
        };
        let broker_thread = run_diagnose_broker(broker_path.clone(), returned_correlation_id);
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        let result = BrokerClient::new(broker_path)
            .unwrap()
            .diagnose(correlation_id, Uuid::new_v4());
        if mismatch {
            assert!(result.is_err());
        } else {
            let diagnostic = result.unwrap();
            assert_eq!(diagnostic.correlation_id, correlation_id);
            assert_eq!(diagnostic.phase, BrokerPhase::Prepared);
            assert_eq!(diagnostic.init_pid, Some(INIT_PID));
            assert_eq!(diagnostic.runc_state, Some(BrokerRuncState::Created));
            assert!(diagnostic.pidfd_live);
            assert!(diagnostic.pidfd_pid_matches);
            assert!(diagnostic.control_lease_connected);
            assert_eq!(diagnostic.child_count, 1);
            assert!(!diagnostic.cleanup_failure);
        }
        broker_thread.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn unknown_diagnostic_pair_maps_to_closed_not_found() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let broker_thread = run_not_found_diagnose_broker(broker_path.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let error = BrokerClient::new(broker_path)
        .unwrap()
        .diagnose(Uuid::new_v4(), Uuid::new_v4())
        .unwrap_err();
    assert_eq!(
        error.category,
        firecrawl_browser_execution_adapter::redaction::AdapterErrorCategory::NotFound
    );
    assert_eq!(error.message, "Host job was not found");
    broker_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn adapter_health_verifies_installed_identity_and_returns_closed_result() {
    let root = temporary_root();
    let (protocol_root, protocol_sha256) = installed_health_fixture(&root);
    let broker_path = root.join("broker.sock");
    let adapter_path = root.join("adapter.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let socket_guard = std::os::unix::net::UnixListener::bind(&adapter_path).unwrap();
    fs::set_permissions(&adapter_path, fs::Permissions::from_mode(0o600)).unwrap();
    let broker_thread = run_health_broker(broker_path.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let service = AdapterService::with_dependencies(
        AdapterConfig {
            adapter_socket: adapter_path,
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root,
            max_prompt_runs: 1,
            max_code_runs: 2,
        },
        BrokerClient::new(broker_path).unwrap(),
        JobRegistry::new(1, 2).unwrap(),
        synthetic_bundle(),
    );
    let request_id = Uuid::new_v4();
    let (mut api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    api.write_all(
        format!(
            "{}\n",
            json!({
                "version": 1,
                "requestId": request_id,
                "method": "health",
                "body": {}
            })
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut reader = BufReader::new(api);
    let response = read_json_line(&mut reader).await;
    assert_eq!(
        response,
        json!({
            "version": 1,
            "requestId": request_id,
            "type": "result",
            "body": {
                "version": 1,
                "status": "ok",
                "codexCliVersion": "0.145.0",
                "codexArtifactSha256": sha256(b"codex-artifact"),
                "codexProtocolSchemaSha256": protocol_sha256,
                "brokerProtocolSha256":
                    firecrawl_browser_execution_adapter::broker_client::BROKER_CONTRACT_SHA256,
                "model": "gpt-5.6-terra",
                "reasoningEffort": "medium"
            }
        })
    );
    handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    drop(socket_guard);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn adapter_health_fails_closed_on_installed_checksum_drift() {
    let root = temporary_root();
    let (protocol_root, _) = installed_health_fixture(&root);
    let broker_path = root.join("missing-broker.sock");
    let adapter_path = root.join("adapter.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let socket_guard = std::os::unix::net::UnixListener::bind(&adapter_path).unwrap();
    fs::set_permissions(&adapter_path, fs::Permissions::from_mode(0o600)).unwrap();
    write_regular(
        &root.join("current/bin/firecrawl-browser-execution-adapter"),
        b"tampered",
    );
    let service = AdapterService::with_dependencies(
        AdapterConfig {
            adapter_socket: adapter_path,
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root,
            max_prompt_runs: 1,
            max_code_runs: 2,
        },
        BrokerClient::new(broker_path).unwrap(),
        JobRegistry::new(1, 2).unwrap(),
        synthetic_bundle(),
    );
    let request_id = Uuid::new_v4();
    let (mut api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    api.write_all(
        format!(
            "{}\n",
            json!({
                "version": 1,
                "requestId": request_id,
                "method": "health",
                "body": {}
            })
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut reader = BufReader::new(api);
    assert_eq!(
        read_json_line(&mut reader).await,
        json!({
            "version": 1,
            "requestId": request_id,
            "type": "error",
            "error": {
                "category": "codex_unavailable",
                "message": "Codex execution is unavailable"
            }
        })
    );
    handler.await.unwrap().unwrap();
    drop(socket_guard);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn adapter_status_returns_one_closed_broker_authoritative_record() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let broker_thread = run_status_broker(
        broker_path.clone(),
        Some(json!({
            "type": "status_result",
            "prepared_jobs": 2,
            "starting_jobs": 3,
            "running_jobs": 4,
            "unsettled_jobs": 6,
            "orphan_processes": 5
        })),
    );
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let service = AdapterService::with_dependencies(
        AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: root.join("unused-token"),
            codex_auth_file: root.join("unused-auth"),
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        },
        BrokerClient::new(broker_path).unwrap(),
        JobRegistry::new(1, 2).unwrap(),
        synthetic_bundle(),
    );
    let request_id = Uuid::new_v4();
    let (mut api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    api.write_all(
        format!(
            "{}\n",
            json!({
                "version": 1,
                "requestId": request_id,
                "method": "status",
                "body": {}
            })
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut reader = BufReader::new(api);
    assert_eq!(
        read_json_line(&mut reader).await,
        json!({
            "version": 1,
            "requestId": request_id,
            "type": "result",
            "body": {
                "version": 1,
                "preparedHostJobs": 2,
                "startingHostJobs": 3,
                "runningHostJobs": 4,
                "unsettledHostJobs": 6,
                "orphanProcesses": 5
            }
        })
    );
    handler.await.unwrap().unwrap();
    let mut trailing = String::new();
    assert_eq!(reader.read_line(&mut trailing).await.unwrap(), 0);
    broker_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn broker_status_rejects_eof_and_extra_response_fields() {
    for (index, response) in [
        None,
        Some(json!({
            "type": "status_result",
            "prepared_jobs": 0,
            "starting_jobs": 0,
            "running_jobs": 0,
            "unsettled_jobs": 0,
            "orphan_processes": 0,
            "extra": true
        })),
    ]
    .into_iter()
    .enumerate()
    {
        let root = temporary_root();
        let broker_path = root.join(format!("broker-{index}.sock"));
        let broker_thread = run_status_broker(broker_path.clone(), response);
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }
        assert!(BrokerClient::new(broker_path).unwrap().status().is_err());
        broker_thread.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn adapter_diagnose_host_job_returns_one_closed_exact_record() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    let token_path = root.join("adapter.token");
    write_private(&auth_path, "{}");
    write_private(&token_path, "x".repeat(43));
    let correlation_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let broker_thread = run_diagnose_broker(broker_path.clone(), correlation_id);
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let registry = JobRegistry::new(1, 2).unwrap();
    let reserved = registry
        .reserve_correlated(
            run_id,
            firecrawl_browser_execution_adapter::jobs::JobKind::Code,
            job_id,
            Uuid::new_v4(),
            correlation_id,
        )
        .unwrap();
    reserved.lifecycle.record_payload_started();
    reserved.lifecycle.record_callback();
    reserved.lifecycle.record_browser_effect();
    let service = AdapterService::with_dependencies(
        AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:3002".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused-protocol"),
            max_prompt_runs: 1,
            max_code_runs: 2,
        },
        BrokerClient::new(broker_path).unwrap(),
        registry,
        synthetic_bundle(),
    );
    let request_id = Uuid::new_v4();
    let (mut api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    api.write_all(
        format!(
            "{}\n",
            json!({
                "version": 1,
                "requestId": request_id,
                "method": "diagnose_host_job",
                "body": {
                    "correlationId": correlation_id,
                    "jobId": job_id
                }
            })
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut reader = BufReader::new(api);
    let response = read_json_line(&mut reader).await;
    assert_eq!(
        response,
        json!({
            "version": 1,
            "requestId": request_id,
            "type": "result",
            "body": {
                "version": 1,
                "correlationId": correlation_id,
                "jobId": job_id,
                "phase": "prepared",
                "hostInitPid": INIT_PID,
                "pidfdLive": true,
                "pidfdPidMatches": true,
                "controlLeaseConnected": true,
                "inertRelayFdPresent": false,
                "relayListenerPresent": false,
                "cdpRelayOpened": false,
                "payloadStartedCount": 1,
                "payloadMarkerPresent": false,
                "callbackCount": 1,
                "browserEffectCount": 1,
                "runcState": "created",
                "cgroupPresent": true,
                "jobDirectoryPresent": true,
                "childCount": 1,
                "cleanupFailure": false
            }
        })
    );
    handler.await.unwrap().unwrap();
    broker_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[derive(Clone)]
struct TerminalArtifactFixture {
    id: Uuid,
    name: String,
    kind: &'static str,
    content_type: &'static str,
    content: Vec<u8>,
}

#[derive(Clone, Copy)]
enum TerminalArtifactFault {
    None,
    CountMismatch,
    WrongOrder,
    WrongChecksum,
    WrongSize,
    WrongContentType,
    InvalidContent,
    FailedOutcome,
    ProactiveFailed,
    CancelledOutcome,
    Unsealed,
    NonMemfd,
    ExtraDescriptor,
    NonzeroOffset,
}

fn checksum(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn artifact_record(fixture: &TerminalArtifactFixture) -> Value {
    json!({
        "artifactId": fixture.id,
        "name": fixture.name,
        "kind": fixture.kind,
        "contentType": fixture.content_type,
        "byteSize": fixture.content.len(),
        "checksum": checksum(&fixture.content)
    })
}

fn artifact_memfd(fixture: &TerminalArtifactFixture, sealed: bool, offset: u64) -> OwnedFd {
    let descriptor = memfd_create(
        format!("firecrawl-artifact-{}", fixture.id).as_str(),
        MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING,
    )
    .unwrap();
    let mut written = 0;
    while written < fixture.content.len() {
        written += write(&descriptor, &fixture.content[written..]).unwrap();
    }
    if sealed {
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
    }
    lseek(&descriptor, offset as i64, Whence::SeekSet).unwrap();
    descriptor
}

fn count_artifact_memfds(ids: &[Uuid]) -> usize {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .filter(|target| {
            ids.iter()
                .any(|id| target.to_string_lossy().contains(&id.to_string()))
        })
        .count()
}

fn run_terminal_artifact_exchange(
    fixtures: Vec<TerminalArtifactFixture>,
    fault: TerminalArtifactFault,
) -> Result<BrokerTerminal, ()> {
    let root = temporary_root();
    let socket_path = root.join("broker.sock");
    let auth_path = root.join("auth.json");
    write_private(&auth_path, br#"{"OPENAI_API_KEY":"fixture"}"#);
    let broker_path = socket_path.clone();
    let broker_fixtures = fixtures.clone();
    let broker = std::thread::spawn(move || {
        let listener = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        bind(listener.as_raw_fd(), &UnixAddr::new(&broker_path).unwrap()).unwrap();
        listen(&listener, Backlog::new(1).unwrap()).unwrap();
        let connection = accept(listener.as_raw_fd()).unwrap();
        let (prepare, _prepare_descriptors) = receive_prepare(connection);
        send_packet(
            connection,
            json!({
                "type":"prepared",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID
            }),
        );
        if matches!(fault, TerminalArtifactFault::ProactiveFailed) {
            send_packet(
                connection,
                json!({
                    "type":"terminal",
                    "job_id":prepare["job_id"],
                    "init_pid":INIT_PID,
                    "outcome":"failed",
                    "artifacts":[]
                }),
            );
            shutdown(connection, Shutdown::Read).unwrap();
            return;
        }
        let cancel = receive_packet(connection);
        assert_eq!(cancel["method"], "cancel");

        let mut records = broker_fixtures
            .iter()
            .map(artifact_record)
            .collect::<Vec<_>>();
        if matches!(fault, TerminalArtifactFault::WrongChecksum) {
            records[0]["checksum"] =
                json!("0000000000000000000000000000000000000000000000000000000000000000");
        }
        if matches!(fault, TerminalArtifactFault::WrongSize) {
            records[0]["byteSize"] = json!(broker_fixtures[0].content.len() + 1);
        }
        if matches!(fault, TerminalArtifactFault::WrongContentType) {
            records[0]["contentType"] = json!("application/x-firecrawl");
        }
        if matches!(fault, TerminalArtifactFault::InvalidContent) {
            records[0]["kind"] = json!("screenshot");
            records[0]["contentType"] = json!("image/jpeg");
        }

        let mut descriptors = broker_fixtures
            .iter()
            .map(|fixture| {
                artifact_memfd(
                    fixture,
                    !matches!(fault, TerminalArtifactFault::Unsealed),
                    u64::from(matches!(fault, TerminalArtifactFault::NonzeroOffset)),
                )
            })
            .collect::<Vec<_>>();
        if matches!(fault, TerminalArtifactFault::NonMemfd) {
            let (read_end, write_end) = pipe2(OFlag::O_CLOEXEC).unwrap();
            write(&write_end, &broker_fixtures[0].content).unwrap();
            drop(write_end);
            descriptors[0] = read_end;
        }
        if matches!(fault, TerminalArtifactFault::WrongOrder) {
            descriptors.swap(0, 1);
        }
        if matches!(fault, TerminalArtifactFault::CountMismatch) {
            descriptors.pop();
        }
        if matches!(fault, TerminalArtifactFault::ExtraDescriptor) {
            descriptors.push(artifact_memfd(&broker_fixtures[0], true, 0));
        }
        let descriptor_numbers = descriptors
            .iter()
            .map(AsRawFd::as_raw_fd)
            .collect::<Vec<_>>();
        send_packet_with_fds(
            connection,
            json!({
                "type":"terminal",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID,
                "outcome":if matches!(fault, TerminalArtifactFault::FailedOutcome) {
                    "failed"
                } else if matches!(fault, TerminalArtifactFault::CancelledOutcome) {
                    "cancelled"
                } else {
                    "completed"
                },
                "artifacts":records
            }),
            &descriptor_numbers,
        );
    });
    while !socket_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }
    let client = BrokerClient::new(socket_path).unwrap();
    let mut prepared = client
        .prepare_codex(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            u64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap()
                + 30_000,
            &auth_path,
        )
        .unwrap();
    let result = client
        .finish(&mut prepared, Uuid::new_v4(), BrokerCancelReason::Shutdown)
        .map_err(|_| ());
    broker.join().unwrap();
    fs::remove_dir_all(root).unwrap();
    result
}

#[tokio::test]
async fn terminal_artifacts_accept_zero_and_multiple_in_descriptor_order() {
    let empty = run_terminal_artifact_exchange(Vec::new(), TerminalArtifactFault::None).unwrap();
    assert_eq!(empty.outcome, BrokerTerminalOutcome::Completed);
    assert!(empty.artifacts.is_empty());

    let fixtures = vec![
        TerminalArtifactFixture {
            id: Uuid::new_v4(),
            name: "result.png".to_owned(),
            kind: "screenshot",
            content_type: "image/png",
            content: b"\x89PNG\r\n\x1a\nfirst artifact".to_vec(),
        },
        TerminalArtifactFixture {
            id: Uuid::new_v4(),
            name: "trace.zip".to_owned(),
            kind: "trace",
            content_type: "application/zip",
            content: b"PK\x03\x04trace artifact".to_vec(),
        },
        TerminalArtifactFixture {
            id: Uuid::new_v4(),
            name: "screen.jpg".to_owned(),
            kind: "screenshot",
            content_type: "image/jpeg",
            content: b"\xff\xd8\xffjpeg artifact".to_vec(),
        },
        TerminalArtifactFixture {
            id: Uuid::new_v4(),
            name: "recording.webm".to_owned(),
            kind: "recording",
            content_type: "video/webm",
            content: b"\x1a\x45\xdf\xa3webm artifact".to_vec(),
        },
    ];
    let ids = fixtures
        .iter()
        .map(|fixture| fixture.id)
        .collect::<Vec<_>>();
    let artifacts =
        run_terminal_artifact_exchange(fixtures.clone(), TerminalArtifactFault::None).unwrap();
    assert_eq!(artifacts.outcome, BrokerTerminalOutcome::Completed);
    assert_eq!(artifacts.artifacts.len(), ids.len());
    for (artifact, fixture) in artifacts.artifacts.iter().zip(fixtures) {
        assert_eq!(artifact.artifact_id, fixture.id);
        assert_eq!(artifact.name, fixture.name);
        assert_eq!(artifact.content, fixture.content);
    }
    assert_eq!(count_artifact_memfds(&ids), 0);
}

#[tokio::test]
async fn terminal_artifacts_reject_invalid_descriptor_transport_without_leaks() {
    for fault in [
        TerminalArtifactFault::CountMismatch,
        TerminalArtifactFault::WrongOrder,
        TerminalArtifactFault::WrongChecksum,
        TerminalArtifactFault::WrongSize,
        TerminalArtifactFault::WrongContentType,
        TerminalArtifactFault::InvalidContent,
        TerminalArtifactFault::FailedOutcome,
        TerminalArtifactFault::CancelledOutcome,
        TerminalArtifactFault::Unsealed,
        TerminalArtifactFault::NonMemfd,
        TerminalArtifactFault::ExtraDescriptor,
        TerminalArtifactFault::NonzeroOffset,
    ] {
        let fixtures = vec![
            TerminalArtifactFixture {
                id: Uuid::new_v4(),
                name: "first.png".to_owned(),
                kind: "screenshot",
                content_type: "image/png",
                content: b"\x89PNG\r\n\x1a\nfirst".to_vec(),
            },
            TerminalArtifactFixture {
                id: Uuid::new_v4(),
                name: "second.jpg".to_owned(),
                kind: "screenshot",
                content_type: "image/jpeg",
                content: b"\xff\xd8\xffsecond".to_vec(),
            },
        ];
        let ids = fixtures
            .iter()
            .map(|fixture| fixture.id)
            .collect::<Vec<_>>();
        assert!(run_terminal_artifact_exchange(fixtures, fault).is_err());
        assert_eq!(count_artifact_memfds(&ids), 0);
    }
}

#[tokio::test]
async fn finish_consumes_proactive_failed_terminal_after_cancel_send_failure() {
    let terminal =
        run_terminal_artifact_exchange(Vec::new(), TerminalArtifactFault::ProactiveFailed).unwrap();
    assert_eq!(terminal.outcome, BrokerTerminalOutcome::Failed);
    assert!(terminal.artifacts.is_empty());
}

#[tokio::test]
async fn finish_returns_authoritative_failed_outcome_after_cancel() {
    let terminal =
        run_terminal_artifact_exchange(Vec::new(), TerminalArtifactFault::FailedOutcome).unwrap();
    assert_eq!(terminal.outcome, BrokerTerminalOutcome::Failed);
    assert!(terminal.artifacts.is_empty());
}

#[test]
fn shared_contract_rejects_closed_wire_mutations() {
    validate_shared_contract().unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../host/browser-runtime/protocol/sandbox-broker-v1.contract.json");
    let original: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let mutations = [
        {
            let mut value = original.clone();
            value["messages"]["prepare"]["discriminator"]["value"] = json!("Prepare");
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["prepare"]["requiredFields"] =
                json!(["bundle_id", "deadline_unix_ms", "job_id", "method"]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["prepare"]["descriptorRolesByBundle"]["codex-v1"] =
                json!(["stdout", "stdin", "stderr", "auth", "config"]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["prepare"]["descriptorRolesByBundle"]["surprise"] = json!([]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["diagnose"]["requiredFields"] = json!(["job_id", "method"]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["diagnose"]["direction"] = json!("broker_to_adapter");
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["diagnostic"]["requiredFields"]
                .as_array_mut()
                .unwrap()
                .retain(|field| field != "pidfd_live");
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["terminal"]["requiredFields"] = json!(["job_id", "outcome", "type"]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["terminal"]["descriptorRoles"] = json!([]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["error"]["requiredFields"] = json!(["category", "type"]);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["started"]["descriptorRoles"] = json!(["pidfd"]);
            value
        },
        {
            let mut value = original.clone();
            value["phaseOrder"] = json!([
                "prepare",
                "api_accepted",
                "prepared",
                "api_authorized",
                "start",
                "started",
                "terminal"
            ]);
            value
        },
        {
            let mut value = original.clone();
            value["surprise"] = json!(true);
            value
        },
        {
            let mut value = original.clone();
            value["transport"]["maxFrameBytes"] = json!(65_535);
            value
        },
        {
            let mut value = original.clone();
            value["messages"]["surprise"] = original["messages"]["healthy"].clone();
            value
        },
    ];
    for mutation in mutations {
        assert!(validate_shared_contract_bytes(mutation.to_string().as_bytes()).is_err());
    }
    assert!(
        validate_shared_contract_bytes(
            br#"{"contractVersion":1,"contractVersion":1,"messages":{},"phaseOrder":[],"transport":{}}"#
        )
        .is_err()
    );
}
