use std::fs;

use firecrawl_sandbox_broker::bundles::{
    BundlePolicy, NetworkPolicy, rootfs_tree_digest, validate_rootfs_identity_at,
};
use firecrawl_sandbox_broker::protocol::BundleId;

#[test]
fn fixed_bundle_resources_match_closed_policy() {
    for id in BundleId::ALL {
        let policy = BundlePolicy::load(id).unwrap();
        assert_eq!(policy.id, id);
        match id {
            BundleId::CodexV1 => {
                assert_eq!(policy.resources.network, NetworkPolicy::Host);
                assert_eq!(policy.resources.cpu_quota, 200_000);
                assert_eq!(policy.resources.memory_bytes, 2_147_483_648);
                assert_eq!(policy.resources.pids, 128);
                assert_eq!(policy.resources.tmpfs_bytes, 134_217_728);
                assert_eq!(
                    policy.process_args,
                    [
                        "/opt/firecrawl/bin/codex",
                        "app-server",
                        "--strict-config",
                        "--stdio"
                    ]
                );
                assert_eq!(
                    policy.descriptor_roles(),
                    ["stdin", "stdout", "stderr", "auth", "config"]
                );
                assert!(!policy.descriptor_roles().contains(&"relay"));
            }
            _ => {
                assert_eq!(policy.resources.network, NetworkPolicy::None);
                assert_eq!(policy.resources.cpu_quota, 100_000);
                assert_eq!(policy.resources.memory_bytes, 536_870_912);
                assert_eq!(policy.resources.pids, 64);
                assert_eq!(policy.resources.tmpfs_bytes, 67_108_864);
                assert_eq!(
                    policy.descriptor_roles(),
                    ["input", "stdout", "stderr", "relay"]
                );
                let runner = match id {
                    BundleId::CodeNodeV1 => "/opt/firecrawl/bin/run-node.mjs",
                    BundleId::CodePythonV1 => "/opt/firecrawl/bin/run-python.py",
                    BundleId::CodeBashV1 => "/opt/firecrawl/bin/run-bash.sh",
                    BundleId::CodexV1 => unreachable!(),
                };
                assert_eq!(
                    policy.process_args,
                    ["/opt/firecrawl/bin/job-init.py", runner]
                );
            }
        }
    }
}

#[test]
fn seccomp_is_default_deny_and_never_allowlists_privilege_syscalls() {
    let dangerous = [
        "mount",
        "umount2",
        "unshare",
        "setns",
        "ptrace",
        "bpf",
        "perf_event_open",
        "keyctl",
        "init_module",
        "finit_module",
        "delete_module",
        "reboot",
    ];
    for id in BundleId::ALL {
        let seccomp = BundlePolicy::load(id).unwrap().seccomp;
        assert_eq!(seccomp["defaultAction"], "SCMP_ACT_ERRNO");
        let allowed = seccomp["syscalls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["action"] == "SCMP_ACT_ALLOW")
            .flat_map(|rule| rule["names"].as_array().unwrap())
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        assert!(dangerous.iter().all(|name| !allowed.contains(name)));
        assert!(!allowed.contains(&"clone3"));
        if id == BundleId::CodexV1 {
            assert!(!allowed.contains(&"kill"));
        } else {
            assert!(allowed.contains(&"kill"));
        }
        let clone_rule = seccomp["syscalls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["names"] == serde_json::json!(["clone"]))
            .unwrap();
        assert_eq!(
            clone_rule["args"][0],
            serde_json::json!({
                "index":0,
                "value":2114060416_u64,
                "valueTwo":0,
                "op":"SCMP_CMP_MASKED_EQ"
            })
        );
        let clone3_rule = seccomp["syscalls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["names"] == serde_json::json!(["clone3"]))
            .unwrap();
        assert_eq!(clone3_rule["action"], "SCMP_ACT_ERRNO");
        assert_eq!(clone3_rule["errnoRet"], 38);
    }
}

#[test]
fn checked_policy_file_has_exact_bundle_inventory() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../host/browser-runtime/policy/bundles.json"
    );
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(value["version"], 1);
    let bundles = value["bundles"].as_object().unwrap();
    assert_eq!(bundles.len(), 4);
    for id in BundleId::ALL {
        assert!(bundles.contains_key(id.as_str()));
    }
}

#[test]
fn staged_rootfs_identity_rejects_missing_symlink_and_content_tamper() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let temp = tempfile::tempdir().unwrap();
    let rootfs = temp.path().join("rootfs");
    fs::create_dir(&rootfs).unwrap();
    fs::set_permissions(&rootfs, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(rootfs.join("payload"), b"trusted\n").unwrap();
    fs::set_permissions(rootfs.join("payload"), fs::Permissions::from_mode(0o644)).unwrap();
    let uid = nix::unistd::geteuid().as_raw();
    let digest = rootfs_tree_digest(&rootfs, uid).unwrap();
    let identity = temp.path().join("rootfs.identity.json");
    fs::write(
        &identity,
        serde_json::to_vec(&serde_json::json!({
            "version":1,
            "bundleId":"codex-v1",
            "rootfsSha256":digest
        }))
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(&identity, fs::Permissions::from_mode(0o444)).unwrap();
    validate_rootfs_identity_at(&rootfs, &identity, "codex-v1", uid).unwrap();

    fs::set_permissions(rootfs.join("payload"), fs::Permissions::from_mode(0o666)).unwrap();
    assert!(rootfs_tree_digest(&rootfs, uid).is_err());
    fs::set_permissions(rootfs.join("payload"), fs::Permissions::from_mode(0o644)).unwrap();

    fs::write(rootfs.join("payload"), b"tampered\n").unwrap();
    assert!(validate_rootfs_identity_at(&rootfs, &identity, "codex-v1", uid).is_err());
    fs::remove_dir_all(&rootfs).unwrap();
    let real = temp.path().join("real-rootfs");
    fs::create_dir(&real).unwrap();
    symlink(&real, &rootfs).unwrap();
    assert!(validate_rootfs_identity_at(&rootfs, &identity, "codex-v1", uid).is_err());
}
