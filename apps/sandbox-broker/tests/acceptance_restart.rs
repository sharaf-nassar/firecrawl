use std::process::Command;

#[test]
fn restart_helper_has_only_closed_fixed_argument_surface() {
    let binary = env!("CARGO_BIN_EXE_acceptance-restart-broker");
    for arguments in [
        vec![],
        vec!["--restart-prepared"],
        vec!["--restart-prepared", "not-a-uuid", "not-a-uuid"],
        vec![
            "--restart-prepared",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "--unit",
        ],
        vec!["--signal", "TERM"],
        vec!["--check", "--unit"],
    ] {
        let output = Command::new(binary).args(arguments).output().unwrap();
        assert!(!output.status.success());
    }
}

#[test]
fn check_never_accepts_path_unit_signal_pid_or_timeout_overrides() {
    let source = include_str!("../src/bin/acceptance_restart_broker.rs");
    assert!(source.contains("const SERVICE: &str = \"firecrawl-sandbox-broker.service\""));
    assert!(source.contains("const SOCKET: &str = \"firecrawl-sandbox-broker.socket\""));
    assert!(
        source.contains("const BROKER_SOCKET_PATH: &str = \"/run/firecrawl-sandbox/broker.sock\"")
    );
    assert!(
        source.contains("const JOBS_ROOT_BENEATH_FS_ROOT: &str = \"run/firecrawl-sandbox/jobs\"")
    );
    assert!(source.contains("const RUNC_ROOT: &str = \"/run/firecrawl-sandbox/runc\""));
    assert!(!source.contains("std::env::var"));
    assert!(!source.contains("sudo"));
    assert!(!source.contains("/proc/{pid}"));
}

#[test]
fn restart_helper_uses_descriptor_rooted_state_pidfd_and_health_contract() {
    let source = include_str!("../src/bin/acceptance_restart_broker.rs");
    assert!(source.contains("nix::libc::SYS_openat2"));
    assert!(source.contains("OPENAT2_RESOLVE_BENEATH | OPENAT2_RESOLVE_NO_SYMLINKS"));
    assert!(source.contains("validate_prepared_snapshot("));
    assert!(source.contains("nix::libc::SYS_pidfd_open"));
    assert!(source.contains("wait_pidfd_exit(old_pidfd.as_fd(), WAIT_BOUND)"));
    assert!(source.contains("SockType::SeqPacket"));
    assert!(source.contains("BrokerRequest::Health"));
    assert!(source.contains("BrokerResponse::Healthy"));
    assert!(source.contains("credentials.pid() != expected_pid as i32"));
    assert!(source.contains("health_exchange(connection.as_fd(), expected_pid, 0)"));
    assert!(source.contains("credentials.uid() != expected_uid"));
    assert!(source.contains("COMMAND_BOUND"));
}
