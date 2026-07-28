use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader as StdBufReader, IoSlice, IoSliceMut, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};

use firecrawl_browser_execution_adapter::app_server::ProtocolBundle;
use firecrawl_browser_execution_adapter::broker_client::BrokerClient;
use firecrawl_browser_execution_adapter::config::AdapterConfig;
use firecrawl_browser_execution_adapter::jobs::{AdapterService, JobRegistry};
use futures_util::{SinkExt, StreamExt};
use nix::cmsg_space;
use nix::fcntl::{FcntlArg, SealFlag, fcntl};
use nix::sys::memfd::{MFdFlags, memfd_create};
use nix::sys::socket::{
    AddressFamily, Backlog, ControlMessage, ControlMessageOwned, MsgFlags, SockFlag, SockType,
    UnixAddr, accept, bind, listen, recv, recvmsg, send, sendmsg, socket,
};
use nix::unistd::{Whence, lseek, write};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixStream};
use tokio::sync::oneshot;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use uuid::Uuid;

const INIT_PID: u32 = 4242;

fn temporary_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!("firecrawl-code-test-{}", Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    path
}

fn write_private(path: &Path, contents: impl AsRef<[u8]>) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
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

fn receive_prepare(fd: RawFd) -> (Value, Vec<OwnedFd>) {
    let mut buffer = [0_u8; 65_537];
    let mut iov = [IoSliceMut::new(&mut buffer)];
    let mut control = cmsg_space!([RawFd; 4]);
    let message = recvmsg::<()>(fd, &mut iov, Some(&mut control), MsgFlags::empty()).unwrap();
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

fn receive_packet(fd: RawFd) -> Value {
    let mut buffer = [0_u8; 65_537];
    let read = recv(fd, &mut buffer, MsgFlags::empty()).unwrap();
    serde_json::from_slice(&buffer[..read]).unwrap()
}

fn send_packet(fd: RawFd, value: Value) {
    let frame = value.to_string();
    send(fd, frame.as_bytes(), MsgFlags::empty()).unwrap();
}

fn send_packet_with_fds(fd: RawFd, value: Value, descriptors: &[RawFd]) {
    let frame = value.to_string();
    let iov = [IoSlice::new(frame.as_bytes())];
    let control = [ControlMessage::ScmRights(descriptors)];
    sendmsg::<UnixAddr>(fd, &iov, &control, MsgFlags::empty(), None).unwrap();
}

fn test_artifact() -> (OwnedFd, Uuid, Vec<u8>, String) {
    let artifact_id = Uuid::new_v4();
    let content = b"\x89PNG\r\n\x1a\nartifact-body".to_vec();
    let checksum = Sha256::digest(&content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let descriptor = memfd_create(
        format!("firecrawl-artifact-{artifact_id}").as_str(),
        MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING,
    )
    .unwrap();
    write(&descriptor, &content).unwrap();
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
    lseek(&descriptor, 0, Whence::SeekSet).unwrap();
    (descriptor, artifact_id, content, checksum)
}

fn run_code_broker(
    socket_path: PathBuf,
    events: Arc<Mutex<Vec<&'static str>>>,
    with_artifact: bool,
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
        assert_eq!(prepare["bundle_id"], "code-node-v1");
        assert_eq!(descriptors.len(), 4);
        events.lock().unwrap().push("prepare");
        send_packet(
            connection,
            json!({
                "type":"prepared",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared");
        let start = receive_packet(connection);
        assert_eq!(start["method"], "start");
        events.lock().unwrap().push("start");
        send_packet(
            connection,
            json!({
                "type":"started",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID
            }),
        );
        events.lock().unwrap().push("started");

        let mut source = fs::File::from(descriptors.remove(0));
        let mut source_text = String::new();
        source.read_to_string(&mut source_text).unwrap();
        assert_eq!(source_text, "return document.title");
        let mut stdout = fs::File::from(descriptors.remove(0));
        drop(descriptors.remove(0));
        let relay = std::os::unix::net::UnixStream::from(descriptors.remove(0));
        let relay_reader = relay.try_clone().unwrap();
        let mut relay_reader = StdBufReader::new(relay_reader);
        let mut relay_writer = relay;
        events.lock().unwrap().push("cdp_request");
        relay_writer
            .write_all(b"{\"id\":1,\"method\":\"Runtime.enable\"}\n")
            .unwrap();
        relay_writer.flush().unwrap();
        let mut response = String::new();
        relay_reader.read_line(&mut response).unwrap();
        assert_eq!(response, "{\"id\":1,\"result\":{}}\n");
        events.lock().unwrap().push("cdp_response");
        writeln!(stdout, "code-output").unwrap();
        stdout.flush().unwrap();
        drop(stdout);
        drop(relay_reader);
        drop(relay_writer);

        let cancel = receive_packet(connection);
        assert_eq!(cancel["method"], "cancel");
        events.lock().unwrap().push("terminal");
        if with_artifact {
            let (descriptor, artifact_id, content, checksum) = test_artifact();
            send_packet_with_fds(
                connection,
                json!({
                    "type":"terminal",
                    "job_id":prepare["job_id"],
                    "init_pid":INIT_PID,
                    "outcome":"completed",
                    "artifacts":[{
                        "artifactId":artifact_id,
                        "name":"result.png",
                        "kind":"screenshot",
                        "contentType":"image/png",
                        "byteSize":content.len(),
                        "checksum":checksum
                    }]
                }),
                &[descriptor.as_raw_fd()],
            );
        } else {
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
        }
    })
}

fn run_stalled_code_broker(
    socket_path: PathBuf,
    start_tx: mpsc::Sender<()>,
    events: Arc<Mutex<Vec<&'static str>>>,
    confirm_cleanup: bool,
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
        assert_eq!(prepare["bundle_id"], "code-node-v1");
        assert_eq!(descriptors.len(), 4);
        events.lock().unwrap().push("prepare");
        send_packet(
            connection,
            json!({
                "type":"prepared",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared");
        let start = receive_packet(connection);
        assert_eq!(start["method"], "start");
        events.lock().unwrap().push("start");
        start_tx.send(()).unwrap();
        let mut packet = [0_u8; 64];
        assert_eq!(recv(connection, &mut packet, MsgFlags::empty()).unwrap(), 0);
        events.lock().unwrap().push("lease_eof");
        drop(descriptors);
        let cleanup = accept(listener.as_raw_fd()).unwrap();
        let cancel = receive_packet(cleanup);
        assert_eq!(cancel["method"], "cancel");
        assert_eq!(cancel["job_id"], prepare["job_id"]);
        if confirm_cleanup {
            events.lock().unwrap().push("terminal_confirm");
            send_packet(
                cleanup,
                json!({
                    "type":"terminal",
                    "job_id":prepare["job_id"],
                    "init_pid":INIT_PID,
                    "outcome":"cancelled",
                    "artifacts":[]
                }),
            );
        } else {
            events.lock().unwrap().push("terminal_failed");
            nix::unistd::close(cleanup).unwrap();
        }
    })
}

fn run_stalled_prepare_broker(
    socket_path: PathBuf,
    prepare_tx: mpsc::Sender<()>,
    events: Arc<Mutex<Vec<&'static str>>>,
    confirm_cleanup: bool,
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
        events.lock().unwrap().push("prepare");
        prepare_tx.send(()).unwrap();
        let mut packet = [0_u8; 64];
        assert_eq!(recv(connection, &mut packet, MsgFlags::empty()).unwrap(), 0);
        drop(descriptors);
        events.lock().unwrap().push("prepare_eof");

        let cleanup = accept(listener.as_raw_fd()).unwrap();
        let cancel = receive_packet(cleanup);
        assert_eq!(cancel["method"], "cancel");
        assert_eq!(cancel["job_id"], prepare["job_id"]);
        if confirm_cleanup {
            events.lock().unwrap().push("terminal_confirm");
            send_packet(
                cleanup,
                json!({
                    "type":"terminal",
                    "job_id":prepare["job_id"],
                    "init_pid":INIT_PID,
                    "outcome":"cancelled",
                    "artifacts":[]
                }),
            );
        } else {
            events.lock().unwrap().push("terminal_failed");
            nix::unistd::close(cleanup).unwrap();
        }
    })
}

fn run_prestart_cancel_broker(
    socket_path: PathBuf,
    events: Arc<Mutex<Vec<&'static str>>>,
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
        send_packet(
            connection,
            json!({
                "type":"prepared",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID
            }),
        );
        events.lock().unwrap().push("prepared");
        let mut packet = [0_u8; 64];
        assert_eq!(recv(connection, &mut packet, MsgFlags::empty()).unwrap(), 0);
        drop(descriptors);
        events.lock().unwrap().push("lease_eof");

        let cleanup = accept(listener.as_raw_fd()).unwrap();
        let cancel = receive_packet(cleanup);
        assert_eq!(cancel["method"], "cancel");
        assert_eq!(cancel["job_id"], prepare["job_id"]);
        events.lock().unwrap().push("terminal_confirm");
        send_packet(
            cleanup,
            json!({
                "type":"terminal",
                "job_id":prepare["job_id"],
                "init_pid":INIT_PID,
                "outcome":"cancelled",
                "artifacts":[]
            }),
        );
    })
}

fn deadline_iso() -> String {
    deadline_iso_after(10_000)
}

fn deadline_iso_after(after_ms: i64) -> String {
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + after_ms;
    let seconds = unix_ms / 1_000;
    let milliseconds = unix_ms % 1_000;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milliseconds:03}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60,
    )
}

async fn start_authorized_code(
    service: AdapterService,
    run_id: Uuid,
    deadline_ms: i64,
) -> (
    tokio::task::JoinHandle<
        Result<(), firecrawl_browser_execution_adapter::redaction::AdapterError>,
    >,
    BufReader<tokio::net::unix::OwnedReadHalf>,
) {
    let request_id = Uuid::new_v4();
    let (api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "method":"execute_code",
                    "body":{
                        "adapterJobId":Uuid::new_v4(),
                        "adapterSupervisorId":Uuid::new_v4(),
                        "capabilityToken":"c".repeat(43),
                        "runId":run_id,
                        "language":"node",
                        "source":"return document.title",
                        "deadline":deadline_iso_after(deadline_ms),
                        "correlationId":Uuid::new_v4()
                    }
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut accepted = String::new();
    api_reader.read_line(&mut accepted).await.unwrap();
    let accepted: Value = serde_json::from_str(&accepted).unwrap();
    assert_eq!(accepted["type"], "accepted");
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "type":"authorized",
                    "binding":accepted["binding"]
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    api_writer.shutdown().await.unwrap();
    (handler, api_reader)
}

async fn request_cancel(service: AdapterService, run_id: Uuid) -> Value {
    let (api, adapter) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(async move { service.handle_connection(adapter).await });
    let (reader, mut writer) = api.into_split();
    let mut reader = BufReader::new(reader);
    writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":Uuid::new_v4(),
                    "method":"cancel",
                    "body":{"runId":run_id,"reason":"api_cancelled"}
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    reader.read_line(&mut response).await.unwrap();
    handler.await.unwrap().unwrap();
    serde_json::from_str(&response).unwrap()
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn code_holds_cdp_until_broker_terminal_then_releases_before_result() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let token_path = root.join("adapter.token");
    let auth_path = root.join("auth.json");
    write_private(&token_path, "x".repeat(43));
    write_private(&auth_path, "{}");
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_code_broker(broker_path.clone(), events.clone(), false);
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }

    let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback_address = callback.local_addr().unwrap();
    let callback_events = events.clone();
    let callback_task = tokio::spawn(async move {
        let (stream, _) = callback.accept().await.unwrap();
        let mut websocket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert!(request.uri().path().ends_with("/cdp"));
            assert_eq!(
                request.headers()["authorization"],
                format!("Bearer {}", "x".repeat(43))
            );
            callback_events.lock().unwrap().push("cdp_open");
            Ok(response)
        })
        .await
        .unwrap();
        websocket
            .send(Message::Text(
                "{\"version\":1,\"type\":\"cdp_relay_ready\"}".into(),
            ))
            .await
            .unwrap();
        let message = websocket.next().await.unwrap().unwrap();
        assert_eq!(
            message,
            Message::Text("{\"id\":1,\"method\":\"Runtime.enable\"}".into())
        );
        callback_events.lock().unwrap().push("cdp_forward");
        websocket
            .send(Message::Text("{\"id\":1,\"result\":{}}".into()))
            .await
            .unwrap();
        assert!(matches!(
            websocket.next().await,
            Some(Ok(Message::Close(_)))
        ));
        callback_events.lock().unwrap().push("cdp_close");
        websocket.flush().await.unwrap();

        let (mut release, _) = callback.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = release.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        assert!(
            String::from_utf8(request)
                .unwrap()
                .contains("/cdp/released")
        );
        callback_events.lock().unwrap().push("release");
        release
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });

    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: format!("http://{callback_address}"),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused"),
        max_prompt_runs: 1,
        max_code_runs: 2,
    };
    let service = AdapterService::with_dependencies(
        config,
        BrokerClient::new(broker_path).unwrap(),
        JobRegistry::new(1, 2).unwrap(),
        synthetic_bundle(),
    );
    let run_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let supervisor_id = Uuid::new_v4();
    let request_id = Uuid::new_v4();
    let (api, adapter) = UnixStream::pair().unwrap();
    let execute_service = service.clone();
    let handler = tokio::spawn(async move { execute_service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "method":"execute_code",
                    "body":{
                        "adapterJobId":job_id,
                        "adapterSupervisorId":supervisor_id,
                        "capabilityToken":"c".repeat(43),
                        "runId":run_id,
                        "language":"node",
                        "source":"return document.title",
                        "deadline":deadline_iso(),
                        "correlationId":Uuid::new_v4()
                    }
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut accepted = String::new();
    api_reader.read_line(&mut accepted).await.unwrap();
    let accepted: Value = serde_json::from_str(&accepted).unwrap();
    assert_eq!(accepted["type"], "accepted");
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "type":"authorized",
                    "binding":accepted["binding"]
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    api_writer.shutdown().await.unwrap();
    let mut result = String::new();
    api_reader.read_line(&mut result).await.unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["type"], "result");
    assert_eq!(result["body"]["stdout"], "code-output\n");
    events.lock().unwrap().push("result");

    handler.await.unwrap().unwrap();
    callback_task.await.unwrap();
    broker_thread.join().unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "prepare",
            "prepared",
            "cdp_open",
            "start",
            "started",
            "cdp_request",
            "cdp_forward",
            "cdp_response",
            "terminal",
            "cdp_close",
            "release",
            "result",
        ]
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn cancelled_stalled_code_start_closes_broker_lease_and_relay_grant() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let token_path = root.join("adapter.token");
    let auth_path = root.join("auth.json");
    write_private(&token_path, "x".repeat(43));
    write_private(&auth_path, "{}");
    let events = Arc::new(Mutex::new(Vec::new()));
    let (start_tx, start_rx) = mpsc::channel();
    let broker_thread =
        run_stalled_code_broker(broker_path.clone(), start_tx, events.clone(), true);
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }

    let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback_address = callback.local_addr().unwrap();
    let callback_events = events.clone();
    let callback_task = tokio::spawn(async move {
        let (stream, _) = callback.accept().await.unwrap();
        let mut websocket = accept_hdr_async(stream, |_request: &Request, response: Response| {
            callback_events.lock().unwrap().push("cdp_open");
            Ok(response)
        })
        .await
        .unwrap();
        websocket
            .send(Message::Text(
                "{\"version\":1,\"type\":\"cdp_relay_ready\"}".into(),
            ))
            .await
            .unwrap();
        assert!(matches!(
            websocket.next().await,
            Some(Ok(Message::Close(_)))
        ));
        callback_events.lock().unwrap().push("cdp_close");
        websocket.flush().await.unwrap();

        let (mut release, _) = callback.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = release.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        assert!(
            String::from_utf8(request)
                .unwrap()
                .contains("/cdp/released")
        );
        callback_events.lock().unwrap().push("release");
        release
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });

    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: format!("http://{callback_address}"),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused"),
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
    let execute_service = service.clone();
    let handler = tokio::spawn(async move { execute_service.handle_connection(adapter).await });
    let (api_reader, mut api_writer) = api.into_split();
    let mut api_reader = BufReader::new(api_reader);
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "method":"execute_code",
                    "body":{
                        "adapterJobId":Uuid::new_v4(),
                        "adapterSupervisorId":Uuid::new_v4(),
                        "capabilityToken":"c".repeat(43),
                        "runId":run_id,
                        "language":"node",
                        "source":"return document.title",
                        "deadline":deadline_iso(),
                        "correlationId":Uuid::new_v4()
                    }
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut accepted = String::new();
    api_reader.read_line(&mut accepted).await.unwrap();
    let accepted: Value = serde_json::from_str(&accepted).unwrap();
    assert_eq!(accepted["type"], "accepted");
    api_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":request_id,
                    "type":"authorized",
                    "binding":accepted["binding"]
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    api_writer.shutdown().await.unwrap();
    tokio::task::spawn_blocking(move || start_rx.recv_timeout(StdDuration::from_secs(1)).unwrap())
        .await
        .unwrap();
    let (cancel_api, cancel_adapter) = UnixStream::pair().unwrap();
    let cancel_handler =
        tokio::spawn(async move { service.handle_connection(cancel_adapter).await });
    let (cancel_reader, mut cancel_writer) = cancel_api.into_split();
    let mut cancel_reader = BufReader::new(cancel_reader);
    cancel_writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "version":1,
                    "requestId":Uuid::new_v4(),
                    "method":"cancel",
                    "body":{"runId":run_id,"reason":"api_cancelled"}
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut cancelled = String::new();
    cancel_reader.read_line(&mut cancelled).await.unwrap();
    let cancelled: Value = serde_json::from_str(&cancelled).unwrap();
    assert_eq!(cancelled["type"], "result");
    assert_eq!(cancelled["body"]["killed"], true);
    events.lock().unwrap().push("cancel_complete");
    let mut execution_error = String::new();
    api_reader.read_line(&mut execution_error).await.unwrap();
    let execution_error: Value = serde_json::from_str(&execution_error).unwrap();
    assert_eq!(execution_error["type"], "error");
    assert_eq!(execution_error["error"]["category"], "cancelled");
    handler.await.unwrap().unwrap();

    callback_task.await.unwrap();
    broker_thread.join().unwrap();
    cancel_handler.await.unwrap().unwrap();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(registry.terminal_jobs().len(), 1);
    let observed = events.lock().unwrap();
    assert_eq!(&observed[..3], &["prepare", "prepared", "cdp_open"]);
    assert_eq!(observed[3], "start");
    assert!(observed[4..].contains(&"lease_eof"));
    assert!(observed[4..].contains(&"terminal_confirm"));
    assert!(observed[4..].contains(&"cdp_close"));
    let terminal_confirm = observed
        .iter()
        .position(|event| *event == "terminal_confirm")
        .unwrap();
    let cdp_close = observed
        .iter()
        .position(|event| *event == "cdp_close")
        .unwrap();
    let release = observed
        .iter()
        .position(|event| *event == "release")
        .unwrap();
    let cancel_complete = observed
        .iter()
        .position(|event| *event == "cancel_complete")
        .unwrap();
    assert!(terminal_confirm < cdp_close);
    assert!(cdp_close < release);
    assert!(release < cancel_complete);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn unproven_cleanup_returns_framed_error_and_fail_stops_code() {
    for (broker_failure, release_failure) in [(true, false), (false, true)] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let token_path = root.join("adapter.token");
        let auth_path = root.join("auth.json");
        write_private(&token_path, "x".repeat(43));
        write_private(&auth_path, "{}");
        let events = Arc::new(Mutex::new(Vec::new()));
        let (start_tx, start_rx) = mpsc::channel();
        let broker_thread = run_stalled_code_broker(
            broker_path.clone(),
            start_tx,
            events.clone(),
            !broker_failure,
        );
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }

        let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let callback_address = callback.local_addr().unwrap();
        let callback_task = tokio::spawn(async move {
            let (stream, _) = callback.accept().await.unwrap();
            let mut websocket =
                accept_hdr_async(stream, |_request: &Request, response: Response| {
                    Ok(response)
                })
                .await
                .unwrap();
            websocket
                .send(Message::Text(
                    "{\"version\":1,\"type\":\"cdp_relay_ready\"}".into(),
                ))
                .await
                .unwrap();
            assert!(matches!(
                websocket.next().await,
                Some(Ok(Message::Close(_)))
            ));
            websocket.flush().await.unwrap();

            let (mut release, _) = callback.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let read = release.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let response = if release_failure {
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n".as_slice()
            } else {
                b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".as_slice()
            };
            release.write_all(response).await.unwrap();
        });

        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: format!("http://{callback_address}"),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused"),
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
        let (execute, mut execute_reader) =
            start_authorized_code(service.clone(), run_id, 10_000).await;
        tokio::task::spawn_blocking(move || {
            start_rx.recv_timeout(StdDuration::from_secs(1)).unwrap()
        })
        .await
        .unwrap();
        let cancel = tokio::spawn(request_cancel(service.clone(), run_id));
        execute.await.unwrap().unwrap();
        let mut execution_error = String::new();
        execute_reader
            .read_line(&mut execution_error)
            .await
            .unwrap();
        let execution_error: Value = serde_json::from_str(&execution_error).unwrap();
        assert_eq!(execution_error["type"], "error");
        assert_eq!(execution_error["error"]["category"], "sandbox_unavailable");
        let cancel = cancel.await.unwrap();
        assert_eq!(cancel["type"], "error");
        assert_eq!(cancel["error"]["category"], "sandbox_unavailable");
        assert!(cancel.get("body").is_none());
        callback_task.await.unwrap();
        broker_thread.join().unwrap();
        assert_eq!(registry.active_count(), 0);
        assert!(registry.terminal_jobs().is_empty());

        let (api, adapter) = UnixStream::pair().unwrap();
        let fail_stopped = tokio::spawn(async move { service.handle_connection(adapter).await });
        let (reader, mut writer) = api.into_split();
        let mut reader = BufReader::new(reader);
        writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "version":1,
                        "requestId":Uuid::new_v4(),
                        "method":"execute_code",
                        "body":{
                            "adapterJobId":Uuid::new_v4(),
                            "adapterSupervisorId":Uuid::new_v4(),
                            "capabilityToken":"c".repeat(43),
                            "runId":Uuid::new_v4(),
                            "language":"node",
                            "source":"return 1",
                            "deadline":deadline_iso(),
                            "correlationId":Uuid::new_v4()
                        }
                    })
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut fail_stopped_error = String::new();
        reader.read_line(&mut fail_stopped_error).await.unwrap();
        let fail_stopped_error: Value = serde_json::from_str(&fail_stopped_error).unwrap();
        assert_eq!(fail_stopped_error["type"], "error");
        assert_eq!(
            fail_stopped_error["error"]["category"],
            "sandbox_unavailable"
        );
        fail_stopped.await.unwrap().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn artifact_ack_failure_cannot_downgrade_proven_cleanup() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let token_path = root.join("adapter.token");
    let auth_path = root.join("auth.json");
    write_private(&token_path, "x".repeat(43));
    write_private(&auth_path, "{}");
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_code_broker(broker_path.clone(), events.clone(), true);
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }

    let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback_address = callback.local_addr().unwrap();
    let (artifact_seen_tx, artifact_seen_rx) = oneshot::channel();
    let (reject_artifact_tx, reject_artifact_rx) = oneshot::channel();
    let callback_task = tokio::spawn(async move {
        let (stream, _) = callback.accept().await.unwrap();
        let mut websocket = accept_hdr_async(stream, |_request: &Request, response: Response| {
            Ok(response)
        })
        .await
        .unwrap();
        websocket
            .send(Message::Text(
                "{\"version\":1,\"type\":\"cdp_relay_ready\"}".into(),
            ))
            .await
            .unwrap();
        let message = websocket.next().await.unwrap().unwrap();
        assert_eq!(
            message,
            Message::Text("{\"id\":1,\"method\":\"Runtime.enable\"}".into())
        );
        websocket
            .send(Message::Text("{\"id\":1,\"result\":{}}".into()))
            .await
            .unwrap();
        assert!(matches!(
            websocket.next().await,
            Some(Ok(Message::Close(_)))
        ));
        websocket.flush().await.unwrap();

        let (mut release, _) = callback.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = release.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        release
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();

        let (mut artifact, _) = callback.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let read = artifact.read(&mut chunk).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert!(
            std::str::from_utf8(&request[..header_end])
                .unwrap()
                .contains("/artifacts")
        );
        artifact_seen_tx.send(()).unwrap();
        reject_artifact_rx.await.unwrap();
        artifact
            .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });

    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: format!("http://{callback_address}"),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused"),
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
    let (execute, mut execute_reader) =
        start_authorized_code(service.clone(), run_id, 10_000).await;
    artifact_seen_rx.await.unwrap();

    let cancel = tokio::time::timeout(StdDuration::from_secs(1), request_cancel(service, run_id))
        .await
        .unwrap();
    assert_eq!(cancel["type"], "result");
    assert_eq!(cancel["body"]["killed"], true);

    reject_artifact_tx.send(()).unwrap();
    let mut execution_response = String::new();
    execute_reader
        .read_line(&mut execution_response)
        .await
        .unwrap();
    let execution_response: Value = serde_json::from_str(&execution_response).unwrap();
    assert_eq!(execution_response["type"], "error");
    assert_eq!(
        execution_response["error"]["category"],
        "sandbox_unavailable"
    );
    execute.await.unwrap().unwrap();
    callback_task.await.unwrap();
    broker_thread.join().unwrap();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(registry.terminal_jobs().len(), 1);
    assert_eq!(
        registry.terminal_jobs()[0].category,
        Some(
            firecrawl_browser_execution_adapter::redaction::AdapterErrorCategory::SandboxUnavailable
        )
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn stalled_prepare_cancel_and_deadline_interrupt_before_terminal_proof() {
    for (cancelled, confirm_cleanup) in [(true, true), (false, true), (true, false)] {
        let root = temporary_root();
        let broker_path = root.join("broker.sock");
        let token_path = root.join("adapter.token");
        let auth_path = root.join("auth.json");
        write_private(&token_path, "x".repeat(43));
        write_private(&auth_path, "{}");
        let events = Arc::new(Mutex::new(Vec::new()));
        let (prepare_tx, prepare_rx) = mpsc::channel();
        let broker_thread = run_stalled_prepare_broker(
            broker_path.clone(),
            prepare_tx,
            events.clone(),
            confirm_cleanup,
        );
        while !broker_path.exists() {
            std::thread::sleep(StdDuration::from_millis(1));
        }

        let config = AdapterConfig {
            adapter_socket: root.join("adapter.sock"),
            broker_socket: broker_path.clone(),
            callback_url: "http://127.0.0.1:1".to_owned(),
            callback_token_file: token_path,
            codex_auth_file: auth_path,
            protocol_root: root.join("unused"),
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
        let execute_service = service.clone();
        let execute = tokio::spawn(async move { execute_service.handle_connection(adapter).await });
        let (reader, mut writer) = api.into_split();
        let mut reader = BufReader::new(reader);
        writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "version":1,
                        "requestId":request_id,
                        "method":"execute_code",
                        "body":{
                            "adapterJobId":Uuid::new_v4(),
                            "adapterSupervisorId":Uuid::new_v4(),
                            "capabilityToken":"c".repeat(43),
                            "runId":run_id,
                            "language":"node",
                            "source":"return 1",
                            "deadline":if cancelled {
                                deadline_iso()
                            } else {
                                deadline_iso_after(200)
                            },
                            "correlationId":Uuid::new_v4()
                        }
                    })
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

        let cancel = cancelled.then(|| tokio::spawn(request_cancel(service, run_id)));
        execute.await.unwrap().unwrap();
        let mut execution_error = String::new();
        reader.read_line(&mut execution_error).await.unwrap();
        let execution_error: Value = serde_json::from_str(&execution_error).unwrap();
        assert_eq!(
            execution_error["error"]["category"],
            if !confirm_cleanup {
                "sandbox_unavailable"
            } else if cancelled {
                "cancelled"
            } else {
                "timed_out"
            }
        );
        if let Some(cancel) = cancel {
            let cancel = cancel.await.unwrap();
            if confirm_cleanup {
                assert_eq!(cancel["type"], "result");
                assert_eq!(cancel["body"]["killed"], true);
            } else {
                assert_eq!(cancel["type"], "error");
                assert_eq!(cancel["error"]["category"], "sandbox_unavailable");
                assert!(cancel.get("body").is_none());
            }
        }
        broker_thread.join().unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "prepare",
                "prepare_eof",
                if confirm_cleanup {
                    "terminal_confirm"
                } else {
                    "terminal_failed"
                }
            ]
        );
        assert_eq!(registry.active_count(), 0);
        assert_eq!(registry.terminal_jobs().len(), usize::from(confirm_cleanup));
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn cancellation_interrupts_stalled_relay_ready_without_claiming_release() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let token_path = root.join("adapter.token");
    let auth_path = root.join("auth.json");
    write_private(&token_path, "x".repeat(43));
    write_private(&auth_path, "{}");
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_prestart_cancel_broker(broker_path.clone(), events.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }

    let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback_address = callback.local_addr().unwrap();
    let (handshake_tx, handshake_rx) = oneshot::channel();
    let callback_task = tokio::spawn(async move {
        let (stream, _) = callback.accept().await.unwrap();
        let mut websocket = accept_hdr_async(stream, |_request: &Request, response: Response| {
            Ok(response)
        })
        .await
        .unwrap();
        handshake_tx.send(()).unwrap();
        while websocket.next().await.is_some() {}
    });

    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: format!("http://{callback_address}"),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused"),
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
    let (execute, mut execute_reader) =
        start_authorized_code(service.clone(), run_id, 10_000).await;
    handshake_rx.await.unwrap();
    let cancel = tokio::time::timeout(StdDuration::from_secs(1), request_cancel(service, run_id))
        .await
        .unwrap();
    assert_eq!(cancel["type"], "error");
    assert_eq!(cancel["error"]["category"], "sandbox_unavailable");
    assert!(cancel.get("body").is_none());
    execute.await.unwrap().unwrap();
    let mut execution_error = String::new();
    execute_reader
        .read_line(&mut execution_error)
        .await
        .unwrap();
    let execution_error: Value = serde_json::from_str(&execution_error).unwrap();
    assert_eq!(execution_error["type"], "error");
    assert_eq!(execution_error["error"]["category"], "sandbox_unavailable");
    callback_task.await.unwrap();
    broker_thread.join().unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec!["prepared", "lease_eof", "terminal_confirm"]
    );
    assert_eq!(registry.active_count(), 0);
    assert!(registry.terminal_jobs().is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn deadline_interrupts_stalled_relay_ready_without_starting_broker() {
    let root = temporary_root();
    let broker_path = root.join("broker.sock");
    let token_path = root.join("adapter.token");
    let auth_path = root.join("auth.json");
    write_private(&token_path, "x".repeat(43));
    write_private(&auth_path, "{}");
    let events = Arc::new(Mutex::new(Vec::new()));
    let broker_thread = run_prestart_cancel_broker(broker_path.clone(), events.clone());
    while !broker_path.exists() {
        std::thread::sleep(StdDuration::from_millis(1));
    }

    let callback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback_address = callback.local_addr().unwrap();
    let (handshake_tx, handshake_rx) = oneshot::channel();
    let callback_task = tokio::spawn(async move {
        let (stream, _) = callback.accept().await.unwrap();
        let mut websocket = accept_hdr_async(stream, |_request: &Request, response: Response| {
            Ok(response)
        })
        .await
        .unwrap();
        handshake_tx.send(()).unwrap();
        while websocket.next().await.is_some() {}
    });

    let config = AdapterConfig {
        adapter_socket: root.join("adapter.sock"),
        broker_socket: broker_path.clone(),
        callback_url: format!("http://{callback_address}"),
        callback_token_file: token_path,
        codex_auth_file: auth_path,
        protocol_root: root.join("unused"),
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
    let (execute, mut execute_reader) = start_authorized_code(service, run_id, 200).await;
    handshake_rx.await.unwrap();
    execute.await.unwrap().unwrap();
    let mut execution_error = String::new();
    execute_reader
        .read_line(&mut execution_error)
        .await
        .unwrap();
    let execution_error: Value = serde_json::from_str(&execution_error).unwrap();
    assert_eq!(execution_error["type"], "error");
    assert_eq!(execution_error["error"]["category"], "sandbox_unavailable");
    callback_task.await.unwrap();
    broker_thread.join().unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec!["prepared", "lease_eof", "terminal_confirm"]
    );
    assert_eq!(registry.active_count(), 0);
    assert!(registry.terminal_jobs().is_empty());
    fs::remove_dir_all(root).unwrap();
}
