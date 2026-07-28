use std::io::Read;
use std::os::unix::fs::{PermissionsExt, symlink};

use firecrawl_sandbox_broker::bundles::BundlePolicy;
use firecrawl_sandbox_broker::oci::{
    PRODUCTION_CGROUPS_PATH, collect_artifacts, generate_oci_config, parse_pid_file,
    parse_runc_state,
};
use firecrawl_sandbox_broker::protocol::{BundleId, RuncState};
use nix::fcntl::{FcntlArg, SealFlag, fcntl};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

#[test]
fn codex_oci_is_fixed_readonly_nonroot_and_has_no_hooks_or_relay() {
    let temp = secure_temp();
    let policy = BundlePolicy::load(BundleId::CodexV1).unwrap();
    let job_id = Uuid::new_v4();
    let config = generate_oci_config(job_id, &policy, temp.path()).unwrap();
    assert!(config.get("hooks").is_none());
    assert_eq!(config["root"]["readonly"], true);
    assert_eq!(config["process"]["user"]["uid"], 65532);
    assert_eq!(config["process"]["user"]["gid"], 65532);
    assert_eq!(config["process"]["noNewPrivileges"], true);
    assert_eq!(
        config["process"]["args"],
        serde_json::json!([
            "/opt/firecrawl/bin/codex",
            "app-server",
            "--strict-config",
            "--stdio"
        ])
    );
    assert_eq!(
        config["mounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|mount| mount["destination"] == "/dev/null")
            .unwrap(),
        &serde_json::json!({
            "destination":"/dev/null",
            "type":"bind",
            "source":"/dev/null",
            "options":["bind","rw","nosuid","noexec","nodev"]
        })
    );
    assert_eq!(config["process"]["cwd"], "/run/firecrawl-work");
    for capability in [
        "ambient",
        "bounding",
        "effective",
        "inheritable",
        "permitted",
    ] {
        assert_eq!(
            config["process"]["capabilities"][capability],
            serde_json::json!([])
        );
    }
    let namespaces = config["linux"]["namespaces"].as_array().unwrap();
    assert!(!namespaces.iter().any(|entry| entry["type"] == "network"));
    assert_eq!(config["linux"]["resources"]["cpu"]["quota"], 200_000);
    assert_eq!(
        config["linux"]["resources"]["memory"]["limit"],
        2_147_483_648_u64
    );
    assert_eq!(config["linux"]["resources"]["pids"]["limit"], 128);
    assert_eq!(
        config["linux"]["resources"]["memory"]["swap"],
        2_147_483_648_u64
    );
    assert_eq!(tmpfs_total(&config), 134_217_728);
    for destination in ["/run/firecrawl-work", "/run/firecrawl-home"] {
        let mount = config["mounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|mount| mount["destination"] == destination)
            .unwrap();
        assert!(
            mount["options"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("uid=65532"))
        );
        assert!(
            mount["options"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("gid=65532"))
        );
    }
}

#[test]
fn code_oci_has_fresh_network_namespace_and_bounded_resources() {
    let temp = secure_temp();
    for id in [
        BundleId::CodeNodeV1,
        BundleId::CodePythonV1,
        BundleId::CodeBashV1,
    ] {
        let policy = BundlePolicy::load(id).unwrap();
        let config = generate_oci_config(Uuid::new_v4(), &policy, temp.path()).unwrap();
        assert!(config.get("hooks").is_none());
        assert!(
            config["linux"]["namespaces"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["type"] == "network")
        );
        assert_eq!(config["linux"]["resources"]["cpu"]["quota"], 100_000);
        assert_eq!(config["linux"]["resources"]["memory"]["limit"], 536_870_912);
        assert_eq!(config["linux"]["resources"]["pids"]["limit"], 64);
        assert_eq!(config["linux"]["resources"]["memory"]["swap"], 536_870_912);
        assert!(
            config["process"]["env"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("FIRECRAWL_RUNNER_DEADLINE_MS=300000"))
        );
        assert_eq!(
            config["mounts"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|mount| mount["destination"] == "/dev/null")
                .count(),
            1
        );
        let job_id = Uuid::new_v4();
        let config = generate_oci_config(job_id, &policy, temp.path()).unwrap();
        assert_eq!(
            config["linux"]["cgroupsPath"],
            format!("{PRODUCTION_CGROUPS_PATH}/firecrawl-{job_id}")
        );
        // The OCI-owned tmpfs mounts use 32 MiB; the bound artifact source is
        // a separate broker-mounted 32 MiB tmpfs, preserving the 64 MiB total.
        assert_eq!(tmpfs_total(&config), 33_554_432);
        let artifact_mount = config["mounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|mount| mount["destination"] == "/run/firecrawl-job/artifacts")
            .unwrap();
        assert_eq!(artifact_mount["type"], "bind");
        assert_eq!(
            artifact_mount["source"],
            temp.path().join("artifacts").to_string_lossy().as_ref()
        );
    }
}

#[test]
fn pid_and_runc_state_identity_parsing_is_strict() {
    assert_eq!(parse_pid_file(b"123\n").unwrap(), 123);
    for invalid in [b"".as_slice(), b"0", b"-1", b" 1", b"1\n\n", b"1x"] {
        assert!(parse_pid_file(invalid).is_err());
    }
    let temp = secure_temp();
    let job_id = Uuid::new_v4();
    let state = serde_json::json!({
        "ociVersion":"1.2.0",
        "id":job_id,
        "pid":123,
        "status":"created",
        "bundle":temp.path(),
        "rootfs":temp.path(),
        "created":"2026-07-27T00:00:00Z",
        "annotations":{
            "com.firecrawl.bundle":"codex-v1",
            "com.firecrawl.job":job_id
        },
        "owner":""
    });
    let parsed = parse_runc_state(
        &serde_json::to_vec(&state).unwrap(),
        job_id,
        temp.path(),
        temp.path(),
        BundleId::CodexV1,
    )
    .unwrap();
    assert_eq!(parsed.status, RuncState::Created);
    let mut stopped = state.clone();
    stopped["status"] = serde_json::json!("stopped");
    stopped["pid"] = serde_json::json!(0);
    assert_eq!(
        parse_runc_state(
            &serde_json::to_vec(&stopped).unwrap(),
            job_id,
            temp.path(),
            temp.path(),
            BundleId::CodexV1,
        )
        .unwrap()
        .status,
        RuncState::Stopped
    );
    stopped["pid"] = serde_json::json!(1);
    assert!(
        parse_runc_state(
            &serde_json::to_vec(&stopped).unwrap(),
            job_id,
            temp.path(),
            temp.path(),
            BundleId::CodexV1,
        )
        .is_err()
    );
    let mut wrong = state.clone();
    wrong["pid"] = serde_json::json!(0);
    assert!(
        parse_runc_state(
            &serde_json::to_vec(&wrong).unwrap(),
            job_id,
            temp.path(),
            temp.path(),
            BundleId::CodexV1,
        )
        .is_err()
    );
    for mutate in [
        |value: &mut serde_json::Value| value["pid"] = serde_json::json!(i64::from(i32::MAX) + 1),
        |value: &mut serde_json::Value| value["ociVersion"] = serde_json::json!("1.1.0"),
        |value: &mut serde_json::Value| value["owner"] = serde_json::json!("root"),
        |value: &mut serde_json::Value| value["annotations"] = serde_json::json!({}),
    ] {
        let mut invalid = state.clone();
        mutate(&mut invalid);
        assert!(
            parse_runc_state(
                &serde_json::to_vec(&invalid).unwrap(),
                job_id,
                temp.path(),
                temp.path(),
                BundleId::CodexV1,
            )
            .is_err()
        );
    }
    assert!(parse_pid_file(b"01\n").is_err());
    assert!(parse_pid_file(b"2147483648\n").is_err());
}

#[test]
fn artifact_manifest_is_closed_checksummed_and_returned_as_sealed_memfd() {
    let temp = secure_temp();
    let files = temp.path().join("files");
    std::fs::create_dir(&files).unwrap();
    let contents = b"\x89PNG\r\n\x1a\nbounded artifact";
    std::fs::write(files.join("result.png"), contents).unwrap();
    let checksum = hex(&Sha256::digest(contents));
    let id = Uuid::new_v4();
    std::fs::write(
        temp.path().join("manifest.json"),
        serde_json::to_vec(&serde_json::json!([{
            "artifactId":id,
            "name":"result.png",
            "kind":"screenshot",
            "contentType":"image/png",
            "byteSize":contents.len(),
            "checksum":checksum
        }]))
        .unwrap(),
    )
    .unwrap();
    let artifacts = collect_artifacts(temp.path()).unwrap();
    assert_eq!(artifacts.len(), 1);
    let seals = SealFlag::from_bits_truncate(
        fcntl(&artifacts[0].descriptor, FcntlArg::F_GET_SEALS).unwrap(),
    );
    assert!(seals.contains(
        SealFlag::F_SEAL_WRITE
            | SealFlag::F_SEAL_GROW
            | SealFlag::F_SEAL_SHRINK
            | SealFlag::F_SEAL_SEAL
    ));
    let duplicate = nix::unistd::dup(&artifacts[0].descriptor).unwrap();
    let mut file = std::fs::File::from(duplicate);
    let mut actual = Vec::new();
    file.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, contents);
}

#[test]
fn artifact_kind_and_content_type_pairs_match_api_contract() {
    for (name, kind, content_type, contents) in [
        (
            "screen.png",
            "screenshot",
            "image/png",
            b"\x89PNG\r\n\x1a\npng".as_slice(),
        ),
        (
            "screen.jpg",
            "screenshot",
            "image/jpeg",
            b"\xff\xd8\xffjpeg".as_slice(),
        ),
        (
            "trace.zip",
            "trace",
            "application/zip",
            b"PK\x03\x04zip".as_slice(),
        ),
        (
            "recording.webm",
            "recording",
            "video/webm",
            b"\x1a\x45\xdf\xa3webm".as_slice(),
        ),
    ] {
        let temp = secure_temp();
        let files = temp.path().join("files");
        std::fs::create_dir(&files).unwrap();
        std::fs::write(files.join(name), contents).unwrap();
        std::fs::write(
            temp.path().join("manifest.json"),
            serde_json::to_vec(&serde_json::json!([{
                "artifactId":Uuid::new_v4(),
                "name":name,
                "kind":kind,
                "contentType":content_type,
                "byteSize":contents.len(),
                "checksum":hex(&Sha256::digest(contents))
            }]))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(collect_artifacts(temp.path()).unwrap().len(), 1);
    }
}

#[test]
fn artifact_traversal_symlink_hardlink_sparse_and_checksum_attacks_fail_closed() {
    let temp = secure_temp();
    let files = temp.path().join("files");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(files.join("safe.txt"), b"x").unwrap();
    let outside = temp.path().join("outside.txt");
    std::fs::write(&outside, b"x").unwrap();
    symlink(&outside, files.join("linked.txt")).unwrap();
    let id = Uuid::new_v4();
    for (name, checksum) in [
        ("../outside.txt", hex(&Sha256::digest(b"x"))),
        ("linked.txt", hex(&Sha256::digest(b"x"))),
        ("safe.txt", "0".repeat(64)),
    ] {
        write_manifest(temp.path(), id, name, 1, &checksum);
        assert!(collect_artifacts(temp.path()).is_err(), "{name}");
    }
    std::fs::hard_link(files.join("safe.txt"), files.join("hard.txt")).unwrap();
    write_manifest(temp.path(), id, "hard.txt", 1, &hex(&Sha256::digest(b"x")));
    assert!(collect_artifacts(temp.path()).is_err());

    let sparse = std::fs::File::create(files.join("sparse.bin")).unwrap();
    sparse.set_len(1024 * 1024).unwrap();
    write_manifest(temp.path(), id, "sparse.bin", 1024 * 1024, &"0".repeat(64));
    assert!(collect_artifacts(temp.path()).is_err());
}

#[test]
fn artifact_root_and_files_replacements_fail_closed() {
    let parent = secure_temp();
    let real_root = parent.path().join("real");
    std::fs::create_dir(&real_root).unwrap();
    std::fs::set_permissions(&real_root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let linked_root = parent.path().join("linked");
    symlink(&real_root, &linked_root).unwrap();
    assert!(collect_artifacts(&linked_root).is_err());

    let root = secure_temp();
    let real_files = root.path().join("real-files");
    std::fs::create_dir(&real_files).unwrap();
    symlink(&real_files, root.path().join("files")).unwrap();
    write_manifest(
        root.path(),
        Uuid::new_v4(),
        "result.txt",
        1,
        &hex(&Sha256::digest(b"x")),
    );
    assert!(collect_artifacts(root.path()).is_err());

    std::fs::remove_file(root.path().join("files")).unwrap();
    std::fs::rename(&real_files, root.path().join("files")).unwrap();
    std::fs::write(root.path().join("files/result.txt"), b"replacement").unwrap();
    write_manifest(
        root.path(),
        Uuid::new_v4(),
        "result.txt",
        1,
        &hex(&Sha256::digest(b"x")),
    );
    assert!(collect_artifacts(root.path()).is_err());
}

#[test]
fn artifact_manifest_rejects_unknown_entries_counts_content_and_sizes() {
    let temp = secure_temp();
    let files = temp.path().join("files");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(files.join("result.txt"), b"x").unwrap();
    let id = Uuid::new_v4();
    let checksum = hex(&Sha256::digest(b"x"));

    std::fs::write(
        temp.path().join("manifest.json"),
        serde_json::to_vec(&serde_json::json!([{
            "artifactId":id,
            "name":"result.txt",
            "kind":"text",
            "contentType":"text/plain",
            "byteSize":1,
            "checksum":checksum,
            "unknown":true
        }]))
        .unwrap(),
    )
    .unwrap();
    assert!(collect_artifacts(temp.path()).is_err());

    write_manifest(temp.path(), id, "result.txt", 1, &checksum);
    std::fs::write(files.join("unlisted.txt"), b"x").unwrap();
    assert!(collect_artifacts(temp.path()).is_err());
    std::fs::remove_file(files.join("unlisted.txt")).unwrap();

    std::fs::write(temp.path().join("unlisted"), b"x").unwrap();
    assert!(collect_artifacts(temp.path()).is_err());
    std::fs::remove_file(temp.path().join("unlisted")).unwrap();

    write_manifest(temp.path(), id, "result.txt", 2, &checksum);
    assert!(collect_artifacts(temp.path()).is_err());

    write_manifest(temp.path(), id, "result.txt", 1, &"A".repeat(64));
    assert!(collect_artifacts(temp.path()).is_err());

    for name in ["bad name.txt", "bad\nname.txt", ".hidden"] {
        write_manifest(temp.path(), id, name, 1, &checksum);
        assert!(collect_artifacts(temp.path()).is_err());
    }

    let uppercase_id = id.to_string().to_uppercase();
    std::fs::write(
        temp.path().join("manifest.json"),
        format!(
            r#"[{{"artifactId":"{uppercase_id}","name":"result.txt","kind":"text","contentType":"text/plain","byteSize":1,"checksum":"{checksum}"}}]"#
        ),
    )
    .unwrap();
    assert!(collect_artifacts(temp.path()).is_err());

    std::fs::write(
        temp.path().join("manifest.json"),
        serde_json::to_vec(&serde_json::json!([{
            "artifactId":id,
            "name":"result.txt",
            "kind":"text",
            "contentType":"text/html",
            "byteSize":1,
            "checksum":checksum
        }]))
        .unwrap(),
    )
    .unwrap();
    assert!(collect_artifacts(temp.path()).is_err());

    let records = (0..9)
        .map(|index| {
            serde_json::json!({
                "artifactId":Uuid::new_v4(),
                "name":format!("result-{index}.txt"),
                "kind":"text",
                "contentType":"text/plain",
                "byteSize":0,
                "checksum":hex(&Sha256::digest(b""))
            })
        })
        .collect::<Vec<_>>();
    std::fs::write(
        temp.path().join("manifest.json"),
        serde_json::to_vec(&records).unwrap(),
    )
    .unwrap();
    assert!(collect_artifacts(temp.path()).is_err());
}

fn secure_temp() -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    temp
}

fn write_manifest(root: &std::path::Path, id: Uuid, name: &str, size: usize, checksum: &str) {
    std::fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!([{
            "artifactId":id,
            "name":name,
            "kind":"text",
            "contentType":"text/plain",
            "byteSize":size,
            "checksum":checksum
        }]))
        .unwrap(),
    )
    .unwrap();
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn tmpfs_total(config: &serde_json::Value) -> u64 {
    config["mounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|mount| mount["type"] == "tmpfs")
        .map(|mount| {
            mount["options"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|option| option.as_str())
                .find_map(|option| option.strip_prefix("size="))
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .sum()
}
