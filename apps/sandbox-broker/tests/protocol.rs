use std::io::{IoSlice, IoSliceMut, Read};
use std::os::fd::{AsFd, AsRawFd, FromRawFd};
use std::os::unix::net::{UnixListener, UnixStream};

use firecrawl_sandbox_broker::bundles::FIXED_CODEX_CONFIG;
use firecrawl_sandbox_broker::peer::{
    peer_uid, receive_packet, reject_descriptors, validate_descriptors,
};
use firecrawl_sandbox_broker::protocol::{
    BrokerRequest, BundleId, SHARED_CONTRACT, parse_control, parse_request, validate_request,
    validate_shared_contract, validate_shared_contract_bytes,
};
use nix::fcntl::{FcntlArg, OFlag, SealFlag, fcntl};
use nix::sys::memfd::{MFdFlags, memfd_create};
use nix::sys::socket::{
    AddressFamily, Backlog, ControlMessage, MsgFlags, SockFlag, SockType, UnixAddr, accept4, bind,
    connect, listen, recvmsg, sendmsg, socket, socketpair,
};
use nix::unistd::{pipe2, write};
use serde_json::json;
use uuid::Uuid;

#[test]
fn production_wire_conforms_to_shared_contract() {
    validate_shared_contract().unwrap();
    let request = parse_request(br#"{"method":"health"}"#).unwrap();
    assert_eq!(request, BrokerRequest::Health);
}

#[test]
fn closed_contract_mutation_corpus_is_rejected() {
    let canonical: serde_json::Value = serde_json::from_str(SHARED_CONTRACT).unwrap();
    let mut mutations = Vec::new();

    let mut value = canonical.clone();
    value["messages"]["prepare"]["discriminator"]["value"] = json!("Prepare");
    mutations.push(value);
    let mut value = canonical.clone();
    value["messages"]["prepare"]["direction"] = json!("broker_to_adapter");
    mutations.push(value);
    let mut value = canonical.clone();
    value["messages"]["prepare"]["requiredFields"] =
        json!(["adapter_boot_id", "bundle_id", "method"]);
    mutations.push(value);
    let mut value = canonical.clone();
    value["messages"]["start"]["descriptorRoles"] = json!(["relay"]);
    mutations.push(value);
    let mut value = canonical.clone();
    value["messages"]["prepare"]["descriptorRolesByBundle"]["codex-v1"] =
        json!(["stdin", "stdout", "stderr", "auth", "config", "relay"]);
    mutations.push(value);
    let mut value = canonical.clone();
    value["messages"]["prepare"]["descriptorRolesByBundle"]["code-node-v1"] =
        json!(["relay", "input", "stdout", "stderr"]);
    mutations.push(value);
    let mut value = canonical.clone();
    value["transport"]["preparedControlLease"] = json!("reconnect");
    mutations.push(value);
    let mut value = canonical.clone();
    value["phaseOrder"] = json!(["prepare", "start", "prepared", "terminal"]);
    mutations.push(value);
    let mut value = canonical.clone();
    value["unknown"] = json!(true);
    mutations.push(value);

    for mutation in mutations {
        assert!(validate_shared_contract_bytes(&serde_json::to_vec(&mutation).unwrap()).is_err());
    }
    let duplicate = SHARED_CONTRACT.replacen(
        r#"{"contractVersion":1,"#,
        r#"{"contractVersion":1,"contractVersion":1,"#,
        1,
    );
    assert!(validate_shared_contract_bytes(duplicate.as_bytes()).is_err());
    let trailing = format!("{SHARED_CONTRACT} true");
    assert!(validate_shared_contract_bytes(trailing.as_bytes()).is_err());
}

#[test]
fn request_and_control_are_closed_and_phase_specific() {
    for invalid in [
        br#"{"method":"Health"}"#.as_slice(),
        br#"{"method":"health","extra":true}"#,
        br#"{"method":"prepare"}"#,
        br#"{"method":"start","job_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","expected_init_pid":1}"#,
    ] {
        assert!(parse_request(invalid).is_err());
    }
    for invalid in [
        br#"{"method":"start","job_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","expected_init_pid":1,"extra":true}"#.as_slice(),
        br#"{"method":"abort","job_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}"#,
        br#"{"method":"health"}"#,
    ] {
        assert!(parse_control(invalid).is_err());
    }
}

#[test]
fn peer_credentials_and_ancillary_phase_are_enforced() {
    let (left, right) = socketpair(
        AddressFamily::Unix,
        SockType::SeqPacket,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .unwrap();
    let uid = nix::unistd::geteuid().as_raw();
    assert_eq!(peer_uid(left.as_fd(), uid).unwrap(), uid);
    assert!(peer_uid(left.as_fd(), uid.saturating_add(1)).is_err());

    let descriptor = memfd_create("unexpected", MFdFlags::MFD_CLOEXEC).unwrap();
    let descriptors = [descriptor.as_raw_fd()];
    sendmsg::<()>(
        right.as_raw_fd(),
        &[IoSlice::new(br#"{"method":"health"}"#)],
        &[ControlMessage::ScmRights(&descriptors)],
        MsgFlags::empty(),
        None,
    )
    .unwrap();
    let packet = receive_packet(left.as_fd()).unwrap();
    assert!(reject_descriptors(&packet).is_err());
}

#[test]
fn codex_descriptor_role_count_order_type_direction_and_seals_are_exact() {
    let uid = nix::unistd::geteuid().as_raw();
    let (stdin_read, _stdin_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let auth = sealed("auth", b"{}");
    let config = sealed("config", FIXED_CODEX_CONFIG.as_bytes());
    validate_descriptors(
        BundleId::CodexV1,
        uid,
        vec![stdin_read, stdout_write, stderr_write, auth, config],
    )
    .unwrap();

    let (wrong_stdin_read, wrong_stdin_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let auth = sealed("auth-wrong", b"{}");
    let config = sealed("config-wrong", b"x");
    drop(wrong_stdin_read);
    assert!(
        validate_descriptors(
            BundleId::CodexV1,
            uid,
            vec![wrong_stdin_write, stdout_write, stderr_write, auth, config],
        )
        .is_err()
    );

    let (stdin_read, _stdin_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let unsealed = memfd_create(
        "unsealed",
        MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING,
    )
    .unwrap();
    let config = sealed("config-sealed", b"x");
    assert!(
        validate_descriptors(
            BundleId::CodexV1,
            uid,
            vec![stdin_read, stdout_write, stderr_write, unsealed, config],
        )
        .is_err()
    );
}

#[test]
fn codex_auth_and_config_are_closed_fixed_policy_inputs() {
    for config in [
        FIXED_CODEX_CONFIG.replace("web_search = \"disabled\"", "web_search = \"live\""),
        FIXED_CODEX_CONFIG.replace("hooks = false", "hooks = true"),
        FIXED_CODEX_CONFIG.replace(
            "approval_policy = \"never\"",
            "approval_policy = \"on-request\"",
        ),
    ] {
        assert!(codex_descriptors(b"{}", config.as_bytes()).is_err());
    }
    assert!(
        codex_descriptors(
            br#"{"token":"a","token":"b"}"#,
            FIXED_CODEX_CONFIG.as_bytes()
        )
        .is_err()
    );
    assert!(codex_descriptors(br#"["not-an-object"]"#, FIXED_CODEX_CONFIG.as_bytes()).is_err());
}

#[test]
fn deadlines_are_future_and_capped_at_five_minutes() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    for deadline in [0, now + 600_000] {
        let request = BrokerRequest::Prepare {
            job_id: Uuid::new_v4(),
            adapter_boot_id: Uuid::new_v4(),
            correlation_id: Uuid::new_v4(),
            bundle_id: BundleId::CodexV1,
            deadline_unix_ms: deadline,
        };
        assert!(validate_request(&request).is_err());
    }
}

#[test]
fn abstract_relay_endpoints_are_rejected() {
    let listener = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_CLOEXEC,
        None,
    )
    .unwrap();
    let address =
        UnixAddr::new_abstract(format!("firecrawl-{}", Uuid::new_v4()).as_bytes()).unwrap();
    bind(listener.as_raw_fd(), &address).unwrap();
    listen(&listener, Backlog::new(1).unwrap()).unwrap();
    let client = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_CLOEXEC,
        None,
    )
    .unwrap();
    connect(client.as_raw_fd(), &address).unwrap();
    let accepted = accept4(listener.as_raw_fd(), SockFlag::SOCK_CLOEXEC).unwrap();
    let accepted = unsafe { std::os::fd::OwnedFd::from_raw_fd(accepted) };
    drop(accepted);

    let uid = nix::unistd::geteuid().as_raw();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    assert!(
        validate_descriptors(
            BundleId::CodeNodeV1,
            uid,
            vec![
                sealed("abstract-input", b"x"),
                stdout_write,
                stderr_write,
                client
            ],
        )
        .is_err()
    );
}

#[test]
fn code_input_is_rewound_and_named_same_uid_relay_is_rejected() {
    let uid = nix::unistd::geteuid().as_raw();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (relay, _peer) = socketpair(
        AddressFamily::Unix,
        SockType::Stream,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .unwrap();
    let validated = validate_descriptors(
        BundleId::CodeNodeV1,
        uid,
        vec![
            sealed("code-input", b"return 7"),
            stdout_write,
            stderr_write,
            relay,
        ],
    )
    .unwrap();
    let duplicate = nix::unistd::dup(validated.descriptor("input").unwrap()).unwrap();
    let mut input = std::fs::File::from(duplicate);
    let mut contents = String::new();
    input.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "return 7");

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("named.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let named = UnixStream::connect(&path).unwrap();
    let (_server, _) = listener.accept().unwrap();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    assert!(
        validate_descriptors(
            BundleId::CodeNodeV1,
            uid,
            vec![
                sealed("named-input", b"x"),
                stdout_write,
                stderr_write,
                named.into(),
            ],
        )
        .is_err()
    );
}

#[test]
fn truncated_frames_and_control_are_rejected_without_leaks() {
    let (left, right) = socketpair(
        AddressFamily::Unix,
        SockType::SeqPacket,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .unwrap();
    let oversized = vec![b'x'; 65_537];
    sendmsg::<()>(
        right.as_raw_fd(),
        &[IoSlice::new(&oversized)],
        &[],
        MsgFlags::empty(),
        None,
    )
    .unwrap();
    assert!(receive_packet(left.as_fd()).is_err());

    let (left, right) = socketpair(
        AddressFamily::Unix,
        SockType::SeqPacket,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .unwrap();
    let descriptor = memfd_create("many", MFdFlags::MFD_CLOEXEC).unwrap();
    let raw = [descriptor.as_raw_fd(); 80];
    sendmsg::<()>(
        right.as_raw_fd(),
        &[IoSlice::new(br#"{"method":"health"}"#)],
        &[ControlMessage::ScmRights(&raw)],
        MsgFlags::empty(),
        None,
    )
    .unwrap();
    assert!(receive_packet(left.as_fd()).is_err());

    let mut byte = [0_u8; 1];
    let mut iov = [IoSliceMut::new(&mut byte)];
    let mut control = nix::cmsg_space!([i32; 1]);
    let _ = recvmsg::<()>(
        right.as_raw_fd(),
        &mut iov,
        Some(&mut control),
        MsgFlags::MSG_DONTWAIT,
    );
}

fn sealed(name: &str, bytes: &[u8]) -> std::os::fd::OwnedFd {
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

fn codex_descriptors(
    auth: &[u8],
    config: &[u8],
) -> firecrawl_sandbox_broker::redaction::BrokerResult<
    firecrawl_sandbox_broker::peer::ValidatedDescriptors,
> {
    let (stdin_read, _stdin_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stdout_read, stdout_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    let (_stderr_read, stderr_write) = pipe2(OFlag::O_CLOEXEC).unwrap();
    validate_descriptors(
        BundleId::CodexV1,
        nix::unistd::geteuid().as_raw(),
        vec![
            stdin_read,
            stdout_write,
            stderr_write,
            sealed("auth-policy", auth),
            sealed("config-policy", config),
        ],
    )
}

#[allow(dead_code)]
fn _uuid_anchor(_: Uuid) {}
