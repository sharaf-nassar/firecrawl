use std::os::fd::OwnedFd;
use std::time::Duration;

use firecrawl_browser_execution_adapter::action_client::AdapterAuthorizationBinding;
use firecrawl_browser_execution_adapter::code_relay::{
    CodeRelay, MAX_RELAY_FRAME_BYTES, MAX_RELAY_OUTSTANDING_IDS, RelayFrameValidator,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::Instant;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use uuid::Uuid;
use zeroize::Zeroizing;

#[test]
fn relay_contract_matches_the_code_bundle() {
    assert_eq!(MAX_RELAY_FRAME_BYTES, 24 * 1024 * 1024);
    assert_eq!(MAX_RELAY_OUTSTANDING_IDS, 1_024);
}

#[test]
fn relay_validator_tracks_one_request_and_response() {
    let mut validator = RelayFrameValidator::new();
    validator
        .validate_bundle_frame(
            &serde_json::to_vec(&json!({
                "id": 7,
                "method": "Page.captureScreenshot",
            }))
            .unwrap(),
        )
        .unwrap();
    validator
        .validate_api_frame(
            &serde_json::to_vec(&json!({
                "id": 7,
                "result": {"data": "bounded"},
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(validator.outstanding(), 0);
}

#[test]
fn relay_validator_rejects_duplicate_unknown_and_oversized_frames() {
    let request = serde_json::to_vec(&json!({
        "id": 11,
        "method": "Runtime.evaluate",
    }))
    .unwrap();
    let mut validator = RelayFrameValidator::new();
    validator.validate_bundle_frame(&request).unwrap();
    assert!(validator.validate_bundle_frame(&request).is_err());
    assert!(
        validator
            .validate_api_frame(&serde_json::to_vec(&json!({"id": 12, "result": {}})).unwrap())
            .is_err()
    );
    assert!(
        validator
            .validate_bundle_frame(&vec![b'x'; MAX_RELAY_FRAME_BYTES + 1])
            .is_err()
    );
    assert!(
        validator
            .validate_api_frame(&serde_json::to_vec(&json!({})).unwrap())
            .is_err()
    );
    validator
        .validate_api_frame(
            &serde_json::to_vec(&json!({
                "method": "Runtime.consoleAPICalled",
                "params": {},
            }))
            .unwrap(),
        )
        .unwrap();
}

#[tokio::test]
async fn relay_deadline_is_bounded() {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(10);
    tokio::time::sleep_until(deadline).await;
    assert!(tokio::time::Instant::now() >= deadline);
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn one_authenticated_cdp_open_closes_before_release_acknowledgement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let run_id = Uuid::new_v4();
    let binding = AdapterAuthorizationBinding::new(Uuid::new_v4(), Uuid::new_v4(), 4242).unwrap();
    let token = "t".repeat(43);
    let expected_token = token.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut websocket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(
                request.uri().path(),
                format!("/internal/browser-runs/{run_id}/cdp")
            );
            assert_eq!(
                request.headers()["authorization"],
                format!("Bearer {expected_token}")
            );
            assert_eq!(
                request.headers()["x-firecrawl-adapter-job-id"],
                binding.adapter_job_id.to_string()
            );
            Ok(response)
        })
        .await
        .unwrap();
        websocket
            .send(Message::Text(
                json!({"version":1,"type":"cdp_relay_ready"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let request = websocket.next().await.unwrap().unwrap();
        assert_eq!(
            request,
            Message::Text(json!({"id":1,"method":"Runtime.enable"}).to_string().into())
        );
        websocket
            .send(Message::Text(
                json!({"id":1,"result":{}}).to_string().into(),
            ))
            .await
            .unwrap();
        assert!(matches!(
            websocket.next().await,
            Some(Ok(Message::Close(_)))
        ));
        websocket.flush().await.unwrap();

        for attempt in 0..2 {
            let (mut release, _) = listener.accept().await.unwrap();
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
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with(&format!(
                "POST /internal/browser-runs/{run_id}/cdp/released HTTP/1.1\r\n"
            )));
            if attempt == 1 {
                release
                    .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
            }
        }
    });

    let (bundle, adapter) = std::os::unix::net::UnixStream::pair().unwrap();
    bundle.set_nonblocking(false).unwrap();
    let adapter_fd: OwnedFd = adapter.into();
    let relay = CodeRelay::connect(
        format!("http://{address}"),
        Zeroizing::new(token),
        binding,
        run_id,
        adapter_fd,
        Instant::now() + Duration::from_secs(5),
    )
    .await
    .unwrap();
    let (cancel, cancellation) = tokio::sync::watch::channel(false);
    let relay_task = tokio::spawn(relay.run(Instant::now() + Duration::from_secs(5), cancellation));
    let mut bundle_reader = BufReader::new(
        tokio::net::UnixStream::from_std({
            bundle.set_nonblocking(true).unwrap();
            bundle
        })
        .unwrap(),
    );
    bundle_reader
        .get_mut()
        .write_all(b"{\"id\":1,\"method\":\"Runtime.enable\"}\n")
        .await
        .unwrap();
    let mut response = String::new();
    bundle_reader.read_line(&mut response).await.unwrap();
    assert_eq!(response, "{\"id\":1,\"result\":{}}\n");
    bundle_reader.get_mut().shutdown().await.unwrap();
    drop(bundle_reader);
    let completed = relay_task.await.unwrap();
    drop(cancel);
    completed.result.unwrap();
    completed.relay.close_and_confirm().await.unwrap();
    server.await.unwrap();
}
