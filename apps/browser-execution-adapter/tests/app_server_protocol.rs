use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use firecrawl_browser_execution_adapter::app_server::{
    AppServer, MAX_APP_SERVER_EVENT_BYTES, PromptJob, ProtocolBundle,
};
use firecrawl_browser_execution_adapter::observations::ObservationV1;
use firecrawl_browser_execution_adapter::protocol::BrowserOperation;
use firecrawl_browser_execution_adapter::redaction::AdapterErrorCategory;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;
use tokio::time::{Duration, Instant};
use uuid::Uuid;

const THREAD_ID: &str = "thread-1";
const FIRST_TURN_ID: &str = "01985f6d-9c40-7000-8000-000000000001";
const SECOND_TURN_ID: &str = "01985f6d-9c40-7000-8000-000000000002";
const SCHEMA_LOGICAL_PREFIX: &str = "host/browser-runtime/protocol/codex-app-server/";

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn synthetic_schemas() -> BTreeMap<String, Value> {
    let string = json!({"type": "string"});
    let integer = json!({"type": "integer"});
    let any = true;
    let turn = object_schema(
        json!({
            "id": string,
            "status": string,
            "items": {"type": "array", "items": any},
            "itemsView": string,
            "startedAt": {"type": ["integer", "null"]},
            "completedAt": {"type": ["integer", "null"]},
            "durationMs": {"type": ["integer", "null"]},
            "error": any
        }),
        &["id", "status", "items"],
    );
    let item = object_schema(
        json!({
            "id": string,
            "type": string,
            "text": string,
            "content": {"type": "array", "items": any},
            "summary": {"type": "array", "items": any},
            "memoryCitation": any,
            "phase": any
        }),
        &["id", "type"],
    );
    let item_notification = object_schema(
        json!({
            "threadId": string,
            "turnId": string,
            "completedAtMs": integer,
            "startedAtMs": integer,
            "item": item
        }),
        &["threadId", "turnId", "item"],
    );
    let turn_notification = object_schema(
        json!({"threadId": string, "turn": turn}),
        &["threadId", "turn"],
    );
    let usage_breakdown = object_schema(
        json!({
            "cachedInputTokens": integer,
            "inputTokens": integer,
            "outputTokens": integer,
            "reasoningOutputTokens": integer,
            "totalTokens": integer
        }),
        &[
            "cachedInputTokens",
            "inputTokens",
            "outputTokens",
            "reasoningOutputTokens",
            "totalTokens",
        ],
    );
    let usage = object_schema(
        json!({
            "threadId": string,
            "turnId": string,
            "tokenUsage": object_schema(
                json!({
                    "last": usage_breakdown.clone(),
                    "total": usage_breakdown,
                    "modelContextWindow": {"type": ["integer", "null"]}
                }),
                &["last", "total"],
            )
        }),
        &["threadId", "turnId", "tokenUsage"],
    );
    let mut schemas = BTreeMap::new();
    schemas.insert(
        "v1/InitializeResponse.json".to_owned(),
        object_schema(
            json!({
                "codexHome": string,
                "platformFamily": string,
                "platformOs": string,
                "userAgent": string
            }),
            &["codexHome", "platformFamily", "platformOs", "userAgent"],
        ),
    );
    schemas.insert(
        "v2/ThreadStartResponse.json".to_owned(),
        object_schema(
            json!({"thread": object_schema(json!({"id": string}), &["id"])}),
            &["thread"],
        ),
    );
    schemas.insert(
        "v2/TurnStartResponse.json".to_owned(),
        object_schema(
            json!({"turn": object_schema(json!({"id": string}), &["id"])}),
            &["turn"],
        ),
    );
    schemas.insert(
        "v2/ThreadStartedNotification.json".to_owned(),
        object_schema(json!({"thread": any}), &["thread"]),
    );
    schemas.insert(
        "v2/TurnStartedNotification.json".to_owned(),
        turn_notification.clone(),
    );
    schemas.insert(
        "v2/ItemStartedNotification.json".to_owned(),
        item_notification.clone(),
    );
    schemas.insert(
        "v2/ItemCompletedNotification.json".to_owned(),
        item_notification,
    );
    schemas.insert(
        "v2/TurnCompletedNotification.json".to_owned(),
        turn_notification,
    );
    schemas.insert(
        "v2/ThreadTokenUsageUpdatedNotification.json".to_owned(),
        usage,
    );
    let delta = object_schema(
        json!({
            "threadId": string,
            "turnId": string,
            "itemId": string,
            "delta": string,
            "summaryIndex": integer
        }),
        &["threadId", "turnId"],
    );
    for path in [
        "v2/AgentMessageDeltaNotification.json",
        "v2/ReasoningSummaryPartAddedNotification.json",
        "v2/ReasoningSummaryTextDeltaNotification.json",
        "v2/ReasoningTextDeltaNotification.json",
    ] {
        schemas.insert(path.to_owned(), delta.clone());
    }
    schemas
}

fn synthetic_bundle() -> ProtocolBundle {
    ProtocolBundle::synthetic(synthetic_schemas()).unwrap()
}

struct TemporaryProtocolBundle {
    root: PathBuf,
    schema_path: String,
}

impl Drop for TemporaryProtocolBundle {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sha256(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

fn write_file(root: &Path, relative: &str, raw: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, raw).unwrap();
}

fn temporary_protocol_bundle() -> TemporaryProtocolBundle {
    let root = std::env::temp_dir().join(format!("firecrawl-protocol-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();

    let schemas = synthetic_schemas();
    let inventory: Vec<String> = schemas.keys().cloned().collect();
    let schema_path = inventory[0].clone();
    let mut checksums = BTreeMap::new();
    let mut digest = Sha256::new();
    for (path, schema) in schemas {
        let raw = serde_json::to_vec(&schema).unwrap();
        write_file(&root, &path, &raw);
        checksums.insert(path.clone(), sha256(&raw));
        digest.update(SCHEMA_LOGICAL_PREFIX.as_bytes());
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(&raw);
        digest.update([0]);
    }

    let model_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../host/browser-runtime/protocol/model-decision-envelope-v1.schema.json");
    let model_raw = fs::read(model_path).unwrap();
    write_file(&root, "model-decision-envelope-v1.schema.json", &model_raw);
    checksums.insert(
        "model-decision-envelope-v1.schema.json".to_owned(),
        sha256(&model_raw),
    );

    let manifest = json!({
        "formatVersion": 1,
        "codexIdentity": {
            "executablePath": "/usr/bin/codex",
            "resolvedPath": "/opt/firecrawl/codex",
            "device": "1",
            "inode": "2",
            "version": "0.145.0"
        },
        "schemaInventory": inventory,
        "schemaDigest": format!("{:x}", digest.finalize())
    });
    write_file(
        &root,
        "manifest.json",
        &serde_json::to_vec(&manifest).unwrap(),
    );
    let checksum_text = checksums
        .into_iter()
        .map(|(path, digest)| format!("{digest}  {path}\n"))
        .collect::<String>();
    write_file(&root, "SHA256SUMS", checksum_text.as_bytes());

    TemporaryProtocolBundle { root, schema_path }
}

fn assert_bundle_rejected(bundle: &TemporaryProtocolBundle) {
    assert_eq!(
        ProtocolBundle::load(&bundle.root).unwrap_err().category,
        AdapterErrorCategory::ModelProtocolError
    );
}

fn initial_observation() -> ObservationV1 {
    serde_json::from_value(json!({
        "version": 1,
        "type": "initial",
        "sequence": 0,
        "page": {
            "url": "https://example.test/",
            "title": "Fixture",
            "snapshotExcerpt": "button Submit [ref=@e7]"
        }
    }))
    .unwrap()
}

fn action_observation(sequence: u8) -> ObservationV1 {
    serde_json::from_value(json!({
        "version": 1,
        "type": "action_result",
        "sequence": sequence,
        "actionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "actionKind": "click",
        "outcome": "succeeded",
        "result": {"kind": "click", "applied": true},
        "page": {
            "url": "https://example.test/done",
            "title": "Done",
            "snapshotExcerpt": "complete"
        }
    }))
    .unwrap()
}

async fn read_request<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Value {
    let mut line = String::new();
    assert!(reader.read_line(&mut line).await.unwrap() > 0);
    serde_json::from_str(&line).unwrap()
}

async fn write_frame<W: tokio::io::AsyncWrite + Unpin>(writer: &mut W, value: Value) {
    writer
        .write_all(format!("{value}\n").as_bytes())
        .await
        .unwrap();
}

async fn write_single_turn_preamble<R, W>(reader: &mut BufReader<R>, writer: &mut W)
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let _ = read_request(reader).await;
    write_frame(
        writer,
        json!({"id": 1, "result": {
            "codexHome": "/run/firecrawl-codex",
            "platformFamily": "unix",
            "platformOs": "linux",
            "userAgent": "fixture"
        }}),
    )
    .await;
    let _ = read_request(reader).await;
    let _ = read_request(reader).await;
    write_frame(
        writer,
        json!({"id": 2, "result": {"thread": {"id": THREAD_ID}}}),
    )
    .await;
    let _ = read_request(reader).await;
    write_frame(
        writer,
        json!({"id": 3, "result": {"turn": {"id": FIRST_TURN_ID}}}),
    )
    .await;
}

async fn run_invalid_turn_script(frames: Vec<Vec<u8>>) -> AdapterErrorCategory {
    let (adapter_stream, fixture_stream) = tokio::io::duplex(64 * 1024);
    let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
    let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
    let fixture = tokio::spawn(async move {
        let mut reader = BufReader::new(fixture_reader);
        write_single_turn_preamble(&mut reader, &mut fixture_writer).await;
        for frame in frames {
            if fixture_writer.write_all(&frame).await.is_err() {
                break;
            }
        }
    });
    let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
    let (_cancel, cancellation) = watch::channel(false);
    let error = server
        .run_prompt_job(
            &synthetic_bundle(),
            PromptJob {
                prompt: "finish".to_owned(),
                initial_observation: initial_observation(),
                deadline: Instant::now() + Duration::from_secs(5),
            },
            |_, _| async { unreachable!() },
            cancellation,
        )
        .await
        .unwrap_err();
    fixture.await.unwrap();
    error.category
}

fn encoded_frame(value: Value) -> Vec<u8> {
    format!("{value}\n").into_bytes()
}

fn completed_item(turn_id: &str, text: Value) -> Value {
    json!({
        "method": "item/completed",
        "params": {
            "threadId": THREAD_ID,
            "turnId": turn_id,
            "completedAtMs": 1_750_000_001_000_i64,
            "item": {
                "id": format!("agent-{turn_id}"),
                "type": "agentMessage",
                "text": text.to_string()
            }
        }
    })
}

fn completed_turn(turn_id: &str) -> Value {
    json!({
        "method": "turn/completed",
        "params": {
            "threadId": THREAD_ID,
            "turn": {
                "id": turn_id,
                "status": "completed",
                "items": [],
                "itemsView": "notLoaded",
                "startedAt": 1_750_000_000_i64,
                "completedAt": 1_750_000_001_i64,
                "durationMs": 1000_i64,
                "error": null
            }
        }
    })
}

#[test]
fn temporary_protocol_bundle_loads_and_rejects_exact_mutations() {
    let valid = temporary_protocol_bundle();
    let bundle = ProtocolBundle::load(&valid.root).unwrap();
    bundle
        .validate(
            "v2/ItemCompletedNotification.json",
            &completed_item(
                FIRST_TURN_ID,
                json!({"decision": {"version": 1, "type": "final", "output": "done"}}),
            )["params"],
        )
        .unwrap();
    bundle
        .validate(
            "v2/TurnCompletedNotification.json",
            &completed_turn(FIRST_TURN_ID)["params"],
        )
        .unwrap();

    let digest = temporary_protocol_bundle();
    let manifest_path = digest.root.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["schemaDigest"] = json!("0".repeat(64));
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_bundle_rejected(&digest);

    let inventory = temporary_protocol_bundle();
    let manifest_path = inventory.root.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["schemaInventory"]
        .as_array_mut()
        .unwrap()
        .reverse();
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_bundle_rejected(&inventory);

    let schema_bytes = temporary_protocol_bundle();
    let schema_path = schema_bytes.root.join(&schema_bytes.schema_path);
    let mut raw = fs::read(&schema_path).unwrap();
    raw.push(b' ');
    fs::write(schema_path, raw).unwrap();
    assert_bundle_rejected(&schema_bytes);

    let schema_symlink = temporary_protocol_bundle();
    let schema_path = schema_symlink.root.join(&schema_symlink.schema_path);
    fs::remove_file(&schema_path).unwrap();
    symlink(
        schema_symlink
            .root
            .join("model-decision-envelope-v1.schema.json"),
        schema_path,
    )
    .unwrap();
    assert_bundle_rejected(&schema_symlink);

    let extra_file = temporary_protocol_bundle();
    fs::write(extra_file.root.join("unexpected.json"), b"{}").unwrap();
    assert_bundle_rejected(&extra_file);
}

#[test]
#[ignore = "requires FIRECRAWL_TEST_PROTOCOL_ROOT pointing at an installed snapshot"]
fn installed_protocol_bundle_uses_dynamic_manifest_and_checksums() {
    let root = std::env::var("FIRECRAWL_TEST_PROTOCOL_ROOT")
        .expect("set FIRECRAWL_TEST_PROTOCOL_ROOT to run the installed snapshot test");
    let bundle = ProtocolBundle::load(Path::new(&root)).unwrap();
    bundle
        .validate(
            "v2/ItemCompletedNotification.json",
            &completed_item(
                FIRST_TURN_ID,
                json!({"decision": {"version": 1, "type": "final", "output": "done"}}),
            )["params"],
        )
        .unwrap();
    bundle
        .validate(
            "v2/TurnCompletedNotification.json",
            &completed_turn(FIRST_TURN_ID)["params"],
        )
        .unwrap();
}

#[tokio::test]
async fn one_thread_drives_two_schema_constrained_turns() {
    let (adapter_stream, fixture_stream) = tokio::io::duplex(1024 * 1024);
    let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
    let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
    let fixture = tokio::spawn(async move {
        let mut reader = BufReader::new(fixture_reader);
        let initialize = read_request(&mut reader).await;
        assert_eq!(initialize["id"], 1);
        assert_eq!(initialize["method"], "initialize");
        write_frame(
            &mut fixture_writer,
            json!({"id": 1, "result": {
                "codexHome": "/run/firecrawl-codex",
                "platformFamily": "unix",
                "platformOs": "linux",
                "userAgent": "fixture"
            }}),
        )
        .await;
        assert_eq!(read_request(&mut reader).await["method"], "initialized");
        let thread = read_request(&mut reader).await;
        assert_eq!(thread["id"], 2);
        assert_eq!(thread["params"]["model"], "gpt-5.6-terra");
        assert_eq!(thread["params"]["ephemeral"], true);
        assert_eq!(thread["params"]["dynamicTools"], json!([]));
        write_frame(
            &mut fixture_writer,
            json!({"id": 2, "result": {"thread": {"id": THREAD_ID}}}),
        )
        .await;

        for (index, turn_id) in [FIRST_TURN_ID, SECOND_TURN_ID].into_iter().enumerate() {
            let turn = read_request(&mut reader).await;
            assert_eq!(turn["id"], 3 + index);
            assert_eq!(turn["method"], "turn/start");
            assert_eq!(turn["params"]["threadId"], THREAD_ID);
            assert_eq!(turn["params"]["model"], "gpt-5.6-terra");
            assert_eq!(turn["params"]["effort"], "medium");
            assert!(turn["params"]["outputSchema"].is_object());
            let text = turn["params"]["input"][0]["text"].as_str().unwrap();
            if index == 0 {
                assert_eq!(text.matches("<original_prompt>").count(), 1);
                assert!(text.contains("click Submit"));
            } else {
                assert!(!text.contains("<original_prompt>"));
            }
            write_frame(
                &mut fixture_writer,
                json!({"id": 3 + index, "result": {"turn": {"id": turn_id}}}),
            )
            .await;
            let decision = if index == 0 {
                json!({"decision": {
                    "version": 1,
                    "type": "action",
                    "action": {"kind": "click", "ref": "@e7"}
                }})
            } else {
                json!({"decision": {"version": 1, "type": "final", "output": "done"}})
            };
            write_frame(&mut fixture_writer, completed_item(turn_id, decision)).await;
            write_frame(&mut fixture_writer, completed_turn(turn_id)).await;
        }
    });

    let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
    let (_cancel, cancellation) = watch::channel(false);
    let mut actions = 0;
    let result = server
        .run_prompt_job(
            &synthetic_bundle(),
            PromptJob {
                prompt: "click Submit".to_owned(),
                initial_observation: initial_observation(),
                deadline: Instant::now() + Duration::from_secs(5),
            },
            |sequence, operation| {
                actions += 1;
                async move {
                    assert_eq!(sequence, 1);
                    assert!(matches!(operation, BrowserOperation::Click { .. }));
                    Ok(action_observation(sequence))
                }
            },
            cancellation,
        )
        .await
        .unwrap();
    fixture.await.unwrap();
    assert_eq!(actions, 1);
    assert_eq!(result.output, "done");
    assert_eq!(result.turn_count, 2);
    assert_eq!(result.action_count, 1);
    assert_eq!(result.protocol.tool_event_count, 0);
    assert_eq!(result.protocol.approval_event_count, 0);
}

#[tokio::test]
async fn forbidden_tool_or_approval_event_fails_closed() {
    for method in [
        "item/mcpToolCall/started",
        "item/commandExecution/requestApproval",
        "item/tool/call",
    ] {
        let (adapter_stream, fixture_stream) = tokio::io::duplex(64 * 1024);
        let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
        let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
        let fixture = tokio::spawn(async move {
            let mut reader = BufReader::new(fixture_reader);
            let _ = read_request(&mut reader).await;
            write_frame(
                &mut fixture_writer,
                json!({"id": 1, "result": {
                    "codexHome": "/run/firecrawl-codex",
                    "platformFamily": "unix",
                    "platformOs": "linux",
                    "userAgent": "fixture"
                }}),
            )
            .await;
            let _ = read_request(&mut reader).await;
            let _ = read_request(&mut reader).await;
            write_frame(
                &mut fixture_writer,
                json!({"id": 2, "result": {"thread": {"id": THREAD_ID}}}),
            )
            .await;
            let _ = read_request(&mut reader).await;
            write_frame(
                &mut fixture_writer,
                json!({"id": 3, "result": {"turn": {"id": FIRST_TURN_ID}}}),
            )
            .await;
            write_frame(
                &mut fixture_writer,
                json!({"method": method, "params": {
                    "threadId": THREAD_ID,
                    "turnId": FIRST_TURN_ID
                }}),
            )
            .await;
        });
        let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
        let (_cancel, cancellation) = watch::channel(false);
        let error = server
            .run_prompt_job(
                &synthetic_bundle(),
                PromptJob {
                    prompt: "finish".to_owned(),
                    initial_observation: initial_observation(),
                    deadline: Instant::now() + Duration::from_secs(5),
                },
                |_, _| async { unreachable!() },
                cancellation,
            )
            .await
            .unwrap_err();
        assert_eq!(error.category, AdapterErrorCategory::ModelProtocolError);
        fixture.await.unwrap();
    }
}

#[tokio::test]
async fn duplicate_agent_decision_and_cross_turn_event_fail_closed() {
    for second in [
        completed_item(
            FIRST_TURN_ID,
            json!({"decision": {"version": 1, "type": "final", "output": "two"}}),
        ),
        completed_item(
            SECOND_TURN_ID,
            json!({"decision": {"version": 1, "type": "final", "output": "wrong"}}),
        ),
    ] {
        let (adapter_stream, fixture_stream) = tokio::io::duplex(64 * 1024);
        let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
        let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
        let fixture = tokio::spawn(async move {
            let mut reader = BufReader::new(fixture_reader);
            let _ = read_request(&mut reader).await;
            write_frame(
                &mut fixture_writer,
                json!({"id": 1, "result": {
                    "codexHome": "/run/firecrawl-codex",
                    "platformFamily": "unix",
                    "platformOs": "linux",
                    "userAgent": "fixture"
                }}),
            )
            .await;
            let _ = read_request(&mut reader).await;
            let _ = read_request(&mut reader).await;
            write_frame(
                &mut fixture_writer,
                json!({"id": 2, "result": {"thread": {"id": THREAD_ID}}}),
            )
            .await;
            let _ = read_request(&mut reader).await;
            write_frame(
                &mut fixture_writer,
                json!({"id": 3, "result": {"turn": {"id": FIRST_TURN_ID}}}),
            )
            .await;
            write_frame(
                &mut fixture_writer,
                completed_item(
                    FIRST_TURN_ID,
                    json!({"decision": {"version": 1, "type": "final", "output": "one"}}),
                ),
            )
            .await;
            write_frame(&mut fixture_writer, second).await;
        });
        let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
        let (_cancel, cancellation) = watch::channel(false);
        let error = server
            .run_prompt_job(
                &synthetic_bundle(),
                PromptJob {
                    prompt: "finish".to_owned(),
                    initial_observation: initial_observation(),
                    deadline: Instant::now() + Duration::from_secs(5),
                },
                |_, _| async { unreachable!() },
                cancellation,
            )
            .await
            .unwrap_err();
        assert_eq!(error.category, AdapterErrorCategory::ModelProtocolError);
        fixture.await.unwrap();
    }
}

#[tokio::test]
async fn malformed_eof_failed_missing_unknown_and_late_output_fail_closed() {
    let missing_text = json!({
        "method": "item/completed",
        "params": {
            "threadId": THREAD_ID,
            "turnId": FIRST_TURN_ID,
            "completedAtMs": 1_750_000_001_000_i64,
            "item": {"id": "agent-missing", "type": "agentMessage"}
        }
    });
    let mut failed_turn = completed_turn(FIRST_TURN_ID);
    failed_turn["params"]["turn"]["status"] = json!("failed");
    failed_turn["params"]["turn"]["error"] = json!({"message": "refused"});
    let mut unknown_field = completed_item(
        FIRST_TURN_ID,
        json!({"decision": {"version": 1, "type": "final", "output": "done"}}),
    );
    unknown_field["unexpected"] = json!(true);
    let valid_item = completed_item(
        FIRST_TURN_ID,
        json!({"decision": {"version": 1, "type": "final", "output": "done"}}),
    );
    let scripts = [
        vec![b"{not-json}\n".to_vec()],
        vec![format!(
            "{{\"method\":\"turn/started\",\"method\":\"turn/started\",\"params\":{{\"threadId\":\"{THREAD_ID}\",\"turn\":{{\"id\":\"{FIRST_TURN_ID}\"}}}}}}\n"
        )
        .into_bytes()],
        vec![encoded_frame(json!({
            "method": "thread/started",
            "params": {"thread": {"id": THREAD_ID}}
        }))],
        Vec::new(),
        vec![
            encoded_frame(valid_item.clone()),
            encoded_frame(failed_turn),
        ],
        vec![encoded_frame(missing_text)],
        vec![encoded_frame(unknown_field)],
        vec![
            encoded_frame(valid_item),
            encoded_frame(completed_turn(FIRST_TURN_ID)),
            encoded_frame(json!({"method": "item/reasoning/textDelta", "params": {
                "threadId": THREAD_ID,
                "turnId": FIRST_TURN_ID,
                "itemId": "reasoning-1",
                "delta": "late"
            }})),
        ],
    ];
    for frames in scripts {
        assert_eq!(
            run_invalid_turn_script(frames).await,
            AdapterErrorCategory::ModelProtocolError
        );
    }
}

#[tokio::test]
async fn cancellation_interrupts_a_blocked_action_callback() {
    let (adapter_stream, fixture_stream) = tokio::io::duplex(64 * 1024);
    let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
    let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
    let fixture = tokio::spawn(async move {
        let mut reader = BufReader::new(fixture_reader);
        write_single_turn_preamble(&mut reader, &mut fixture_writer).await;
        write_frame(
            &mut fixture_writer,
            completed_item(
                FIRST_TURN_ID,
                json!({"decision": {
                    "version": 1,
                    "type": "action",
                    "action": {"kind": "click", "ref": "@e7"}
                }}),
            ),
        )
        .await;
        write_frame(&mut fixture_writer, completed_turn(FIRST_TURN_ID)).await;
    });
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (cancel, cancellation) = watch::channel(false);
    let cancellation_task = tokio::spawn(async move {
        started_rx.await.unwrap();
        cancel.send(true).unwrap();
    });
    let mut started_tx = Some(started_tx);
    let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
    let error = server
        .run_prompt_job(
            &synthetic_bundle(),
            PromptJob {
                prompt: "click".to_owned(),
                initial_observation: initial_observation(),
                deadline: Instant::now() + Duration::from_secs(5),
            },
            move |_, _| {
                started_tx.take().unwrap().send(()).unwrap();
                std::future::pending()
            },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.category, AdapterErrorCategory::Cancelled);
    cancellation_task.await.unwrap();
    fixture.await.unwrap();
}

#[tokio::test]
async fn broker_confirmed_termination_rejects_delayed_post_turn_output() {
    let (adapter_stream, fixture_stream) = tokio::io::duplex(64 * 1024);
    let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
    let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let fixture = tokio::spawn(async move {
        let mut reader = BufReader::new(fixture_reader);
        write_single_turn_preamble(&mut reader, &mut fixture_writer).await;
        write_frame(
            &mut fixture_writer,
            completed_item(
                FIRST_TURN_ID,
                json!({"decision": {"version": 1, "type": "final", "output": "done"}}),
            ),
        )
        .await;
        write_frame(&mut fixture_writer, completed_turn(FIRST_TURN_ID)).await;
        release_rx.await.unwrap();
        write_frame(
            &mut fixture_writer,
            json!({
                "method": "item/reasoning/textDelta",
                "params": {
                    "threadId": THREAD_ID,
                    "turnId": FIRST_TURN_ID,
                    "itemId": "reasoning-1",
                    "contentIndex": 0,
                    "delta": "late"
                }
            }),
        )
        .await;
    });
    let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
    let (_cancel, cancellation) = watch::channel(false);
    let result = server
        .run_prompt_job(
            &synthetic_bundle(),
            PromptJob {
                prompt: "finish".to_owned(),
                initial_observation: initial_observation(),
                deadline: Instant::now() + Duration::from_secs(5),
            },
            |_, _| async { unreachable!() },
            cancellation,
        )
        .await
        .unwrap();
    assert_eq!(result.output, "done");
    release_tx.send(()).unwrap();
    assert_eq!(
        server
            .verify_terminated_stdout(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap_err()
            .category,
        AdapterErrorCategory::ModelProtocolError
    );
    fixture.await.unwrap();
}

#[tokio::test]
async fn deadline_interrupts_a_blocked_stdin_write() {
    let (adapter_stream, _fixture_stream) = tokio::io::duplex(1);
    let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
    let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
    let (_cancel, cancellation) = watch::channel(false);
    let error = server
        .run_prompt_job(
            &synthetic_bundle(),
            PromptJob {
                prompt: "finish".to_owned(),
                initial_observation: initial_observation(),
                deadline: Instant::now() + Duration::from_millis(25),
            },
            |_, _| async { unreachable!() },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.category, AdapterErrorCategory::TimedOut);
}

#[tokio::test]
async fn cancellation_interrupts_an_active_turn() {
    let (adapter_stream, fixture_stream) = tokio::io::duplex(64 * 1024);
    let (adapter_stdout, adapter_stdin) = tokio::io::split(adapter_stream);
    let (fixture_reader, mut fixture_writer) = tokio::io::split(fixture_stream);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let fixture = tokio::spawn(async move {
        let mut reader = BufReader::new(fixture_reader);
        write_single_turn_preamble(&mut reader, &mut fixture_writer).await;
        let _ = ready_tx.send(());
        tokio::time::sleep(Duration::from_millis(50)).await;
    });
    let (cancel, cancellation) = watch::channel(false);
    let cancellation_task = tokio::spawn(async move {
        ready_rx.await.unwrap();
        cancel.send(true).unwrap();
    });
    let mut server = AppServer::new(adapter_stdout, adapter_stdin, tokio::io::empty());
    let error = server
        .run_prompt_job(
            &synthetic_bundle(),
            PromptJob {
                prompt: "finish".to_owned(),
                initial_observation: initial_observation(),
                deadline: Instant::now() + Duration::from_secs(5),
            },
            |_, _| async { unreachable!() },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.category, AdapterErrorCategory::Cancelled);
    cancellation_task.await.unwrap();
    fixture.await.unwrap();
}

#[tokio::test]
async fn oversized_stdout_frame_fails_before_unbounded_buffering() {
    let mut frame = vec![b'x'; MAX_APP_SERVER_EVENT_BYTES + 1];
    frame.push(b'\n');
    assert_eq!(
        run_invalid_turn_script(vec![frame]).await,
        AdapterErrorCategory::ModelProtocolError
    );
}
