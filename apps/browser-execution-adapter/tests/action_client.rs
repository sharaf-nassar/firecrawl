use std::collections::BTreeMap;

use firecrawl_browser_execution_adapter::action_client::{
    ActionClient, AdapterAuthorizationBinding,
};
use firecrawl_browser_execution_adapter::broker_client::BrokerArtifact;
use firecrawl_browser_execution_adapter::protocol::{BrowserOperation, ElementRef};
use firecrawl_browser_execution_adapter::redaction::AdapterErrorCategory;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::Duration;
use uuid::Uuid;
use zeroize::Zeroizing;

struct Request {
    path: String,
    headers: BTreeMap<String, String>,
    body_bytes: Vec<u8>,
    body: Value,
}

async fn read_request(stream: &mut TcpStream) -> Request {
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        raw.extend_from_slice(&buffer[..read]);
        if let Some(index) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&raw[..header_end]).unwrap();
    let mut lines = header.split("\r\n");
    let request_line = lines.next().unwrap();
    assert!(request_line.starts_with("POST /internal/browser-runs/"));
    let path = request_line
        .split_ascii_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let headers: BTreeMap<String, String> = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(": ").unwrap();
            (name.to_ascii_lowercase(), value.to_owned())
        })
        .collect();
    let content_length = headers["content-length"].parse::<usize>().unwrap();
    while raw.len() - header_end < content_length {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        raw.extend_from_slice(&buffer[..read]);
    }
    let body_bytes = raw[header_end..header_end + content_length].to_vec();
    Request {
        path,
        headers,
        body: serde_json::from_slice(&body_bytes).unwrap_or(Value::Null),
        body_bytes,
    }
}

fn artifact() -> BrokerArtifact {
    let content = b"\x89PNG\r\n\x1a\nverified".to_vec();
    BrokerArtifact {
        artifact_id: Uuid::new_v4(),
        name: "result.png".to_owned(),
        kind: "screenshot".to_owned(),
        content_type: "image/png".to_owned(),
        byte_size: content.len() as u64,
        checksum: Sha256::digest(&content)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        content,
    }
}

fn artifact_acknowledgement(artifact: &BrokerArtifact) -> Value {
    json!({
        "version": 1,
        "artifactId": artifact.artifact_id,
        "kind": artifact.kind,
        "contentType": artifact.content_type,
        "byteSize": artifact.byte_size,
        "sha256": artifact.checksum
    })
}

async fn write_json(stream: &mut TcpStream, status: &str, body: Value) {
    let body = body.to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

fn fixture_client(origin: String) -> (ActionClient, AdapterAuthorizationBinding, Uuid) {
    let binding = AdapterAuthorizationBinding::new(Uuid::new_v4(), Uuid::new_v4(), 4242).unwrap();
    let run_id = Uuid::new_v4();
    let client =
        ActionClient::new(origin, Zeroizing::new("x".repeat(43)), binding, run_id).unwrap();
    (client, binding, run_id)
}

fn observation(request: &Value) -> Value {
    json!({
        "version": 1,
        "type": "action_result",
        "sequence": request["sequence"],
        "actionId": request["actionId"],
        "actionKind": "click",
        "outcome": "succeeded",
        "result": {"kind": "click", "applied": true},
        "page": {
            "url": "https://example.test/done",
            "title": "Done",
            "snapshotExcerpt": "complete"
        }
    })
}

#[tokio::test]
async fn callback_posts_strict_bound_proposal_and_accepts_proven_outcome() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (client, binding, run_id) = fixture_client(origin);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        assert_eq!(
            request.headers["authorization"],
            format!("Bearer {}", "x".repeat(43))
        );
        assert_eq!(
            request.headers["x-firecrawl-adapter-job-id"],
            binding.adapter_job_id.to_string()
        );
        assert_eq!(
            request.headers["x-firecrawl-adapter-supervisor-id"],
            binding.adapter_supervisor_id.to_string()
        );
        assert_eq!(request.headers["x-firecrawl-adapter-process-id"], "4242");
        assert_eq!(request.body["version"], 1);
        assert_eq!(
            request.body["adapterJobId"],
            binding.adapter_job_id.to_string()
        );
        assert_eq!(request.body["sequence"], 1);
        assert_eq!(request.body["effect"], "side_effecting");
        assert_eq!(
            request.body["operation"],
            json!({"kind": "click", "ref": "@e7"})
        );
        assert_eq!(request.body["proposalHash"].as_str().unwrap().len(), 64);
        write_json(&mut stream, "200 OK", observation(&request.body)).await;
    });
    let result = client
        .execute(
            1,
            BrowserOperation::Click {
                r#ref: ElementRef::new("@e7".to_owned()).unwrap(),
            },
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(matches!(
        result,
        firecrawl_browser_execution_adapter::observations::ObservationV1::ActionResult {
            sequence: 1,
            ..
        }
    ));
    server.await.unwrap();
    let _ = run_id;
}

#[tokio::test]
async fn uncertain_transport_replays_identical_proposal_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (client, _, _) = fixture_client(origin);
    let server = tokio::spawn(async move {
        let (mut first_stream, _) = listener.accept().await.unwrap();
        let first = read_request(&mut first_stream).await;
        drop(first_stream);
        let (mut second_stream, _) = listener.accept().await.unwrap();
        let second = read_request(&mut second_stream).await;
        assert_eq!(first.body, second.body);
        write_json(&mut second_stream, "200 OK", observation(&second.body)).await;
    });
    client
        .execute(
            1,
            BrowserOperation::Click {
                r#ref: ElementRef::new("@e7".to_owned()).unwrap(),
            },
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn partial_response_body_replays_byte_identical_proposal_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (client, _, _) = fixture_client(origin);
    let server = tokio::spawn(async move {
        let (mut first_stream, _) = listener.accept().await.unwrap();
        let first = read_request(&mut first_stream).await;
        let response_body = observation(&first.body).to_string();
        let split = response_body.len() / 2;
        first_stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    &response_body[..split]
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        first_stream.shutdown().await.unwrap();

        let (mut second_stream, _) = listener.accept().await.unwrap();
        let second = read_request(&mut second_stream).await;
        assert_eq!(first.body_bytes, second.body_bytes);
        assert_eq!(first.body["actionId"], second.body["actionId"]);
        assert_eq!(first.body["proposalHash"], second.body["proposalHash"]);
        write_json(&mut second_stream, "200 OK", observation(&second.body)).await;
    });
    client
        .execute(
            1,
            BrowserOperation::Click {
                r#ref: ElementRef::new("@e7".to_owned()).unwrap(),
            },
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn unknown_or_mismatched_outcome_never_reaches_codex() {
    for response in [
        (
            "502 Bad Gateway",
            json!({
                "success": false,
                "error": "action_outcome_unknown",
                "message": "Browser action failed"
            }),
        ),
        (
            "200 OK",
            json!({
                "version": 1,
                "type": "action_result",
                "sequence": 1,
                "actionId": Uuid::new_v4(),
                "actionKind": "click",
                "outcome": "succeeded",
                "result": {"kind": "click", "applied": true},
                "page": {
                    "url": "https://example.test/",
                    "title": "Wrong",
                    "snapshotExcerpt": ""
                }
            }),
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (client, _, _) = fixture_client(origin);
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut stream).await;
            write_json(&mut stream, response.0, response.1).await;
        });
        let error = client
            .execute(
                1,
                BrowserOperation::Click {
                    r#ref: ElementRef::new("@e7".to_owned()).unwrap(),
                },
                Duration::from_secs(2),
            )
            .await
            .unwrap_err();
        assert_eq!(error.category, AdapterErrorCategory::ActionOutcomeUnknown);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn internally_consistent_wrong_action_kind_is_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (client, _, _) = fixture_client(origin);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        write_json(
            &mut stream,
            "200 OK",
            json!({
                "version": 1,
                "type": "action_result",
                "sequence": request.body["sequence"],
                "actionId": request.body["actionId"],
                "actionKind": "fill",
                "outcome": "succeeded",
                "result": {"kind": "fill", "applied": true},
                "page": {
                    "url": "https://example.test/",
                    "title": "Wrong kind",
                    "snapshotExcerpt": ""
                }
            }),
        )
        .await;
    });
    let error = client
        .execute(
            1,
            BrowserOperation::Click {
                r#ref: ElementRef::new("@e7".to_owned()).unwrap(),
            },
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
    assert_eq!(error.category, AdapterErrorCategory::ActionOutcomeUnknown);
    server.await.unwrap();
}

#[tokio::test]
async fn artifact_upload_requires_matching_durable_acknowledgement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (client, binding, run_id) = fixture_client(origin);
    let artifact = artifact();
    let server_artifact = artifact.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        assert_eq!(
            request.path,
            format!("/internal/browser-runs/{run_id}/artifacts")
        );
        assert_eq!(
            request.headers["authorization"],
            format!("Bearer {}", "x".repeat(43))
        );
        assert_eq!(
            request.headers["x-firecrawl-adapter-job-id"],
            binding.adapter_job_id.to_string()
        );
        assert_eq!(
            request.headers["x-firecrawl-artifact-id"],
            server_artifact.artifact_id.to_string()
        );
        assert_eq!(
            request.headers["x-firecrawl-artifact-byte-size"],
            server_artifact.byte_size.to_string()
        );
        assert_eq!(
            request.headers["x-firecrawl-artifact-sha256"],
            server_artifact.checksum
        );
        assert_eq!(request.body_bytes, server_artifact.content);
        write_json(
            &mut stream,
            "201 Created",
            artifact_acknowledgement(&server_artifact),
        )
        .await;
    });
    client
        .upload_artifacts(&[artifact], Duration::from_secs(2))
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn artifact_upload_rejects_missing_extra_and_mismatched_ack_fields() {
    for fault in ["missing", "extra", "identity", "checksum", "size"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (client, _, _) = fixture_client(origin);
        let artifact = artifact();
        let server_artifact = artifact.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut stream).await;
            let mut acknowledgement = artifact_acknowledgement(&server_artifact);
            match fault {
                "missing" => {
                    acknowledgement.as_object_mut().unwrap().remove("sha256");
                }
                "extra" => acknowledgement["unexpected"] = json!(true),
                "identity" => acknowledgement["artifactId"] = json!(Uuid::new_v4()),
                "checksum" => acknowledgement["sha256"] = json!("0".repeat(64)),
                "size" => acknowledgement["byteSize"] = json!(server_artifact.byte_size + 1),
                _ => unreachable!(),
            }
            write_json(&mut stream, "201 Created", acknowledgement).await;
        });
        let error = client
            .upload_artifacts(&[artifact], Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(error.category, AdapterErrorCategory::SandboxUnavailable);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn artifact_upload_bounds_acknowledgement_without_content_length() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (client, _, _) = fixture_client(origin);
    let artifact = artifact();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = read_request(&mut stream).await;
        stream
            .write_all(
                b"HTTP/1.1 201 Created\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        stream.write_all(&vec![b'x'; 4_097]).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let error = client
        .upload_artifacts(&[artifact], Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(error.category, AdapterErrorCategory::SandboxUnavailable);
    server.await.unwrap();
}
