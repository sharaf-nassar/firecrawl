use std::collections::BTreeSet;
use std::os::fd::OwnedFd;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::action_client::AdapterAuthorizationBinding;
use crate::jobs::JobLifecycle;
use crate::protocol::{VersionOne, parse_json_strict};
use crate::redaction::AdapterError;

pub const MAX_RELAY_FRAME_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_RELAY_QUEUE_BYTES: usize = 32 * 1024 * 1024;
pub const PAUSE_RELAY_QUEUE_BYTES: usize = 16 * 1024 * 1024;
pub const RESUME_RELAY_QUEUE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RELAY_OUTSTANDING_IDS: usize = 1_024;
const RELEASE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayReady {
    version: VersionOne,
    #[serde(rename = "type")]
    kind: RelayReadyType,
}

#[derive(Debug, Deserialize)]
enum RelayReadyType {
    #[serde(rename = "cdp_relay_ready")]
    CdpRelayReady,
}

#[derive(Debug, Default)]
struct RelayFlowControl {
    queued_bytes: usize,
    paused: bool,
}

impl RelayFlowControl {
    fn enqueue(&mut self, bytes: usize) -> Result<(), AdapterError> {
        self.queued_bytes = self
            .queued_bytes
            .checked_add(bytes)
            .filter(|queued| *queued <= MAX_RELAY_QUEUE_BYTES)
            .ok_or_else(AdapterError::model_protocol)?;
        if self.queued_bytes >= PAUSE_RELAY_QUEUE_BYTES {
            self.paused = true;
        }
        Ok(())
    }

    fn complete(&mut self, bytes: usize) -> Result<(), AdapterError> {
        self.queued_bytes = self
            .queued_bytes
            .checked_sub(bytes)
            .ok_or_else(AdapterError::model_protocol)?;
        if self.paused && self.queued_bytes <= RESUME_RELAY_QUEUE_BYTES {
            self.paused = false;
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct RelayFrameValidator {
    outstanding: BTreeSet<u64>,
}

impl RelayFrameValidator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn outstanding(&self) -> usize {
        self.outstanding.len()
    }

    pub fn validate_bundle_frame(&mut self, frame: &[u8]) -> Result<(), AdapterError> {
        let object = parse_frame(frame)?;
        let id = object
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or_else(AdapterError::model_protocol)?;
        if object
            .get("method")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
            || self.outstanding.len() >= MAX_RELAY_OUTSTANDING_IDS
            || !self.outstanding.insert(id)
        {
            return Err(AdapterError::model_protocol());
        }
        Ok(())
    }

    pub fn validate_api_frame(&mut self, frame: &[u8]) -> Result<(), AdapterError> {
        let object = parse_frame(frame)?;
        if let Some(id) = object.get("id") {
            let id = id
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or_else(AdapterError::model_protocol)?;
            if !self.outstanding.remove(&id) {
                return Err(AdapterError::model_protocol());
            }
            if object.get("method").is_some()
                || (object.get("result").is_some() == object.get("error").is_some())
            {
                return Err(AdapterError::model_protocol());
            }
        } else if object
            .get("method")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
            || object.get("result").is_some()
            || object.get("error").is_some()
        {
            return Err(AdapterError::model_protocol());
        }
        Ok(())
    }
}

fn parse_frame(frame: &[u8]) -> Result<serde_json::Map<String, Value>, AdapterError> {
    if frame.is_empty()
        || frame.len() > MAX_RELAY_FRAME_BYTES
        || frame.contains(&b'\n')
        || std::str::from_utf8(frame).is_err()
    {
        return Err(AdapterError::model_protocol());
    }
    match parse_json_strict::<Value>(frame).map_err(|_| AdapterError::model_protocol())? {
        Value::Object(object) => Ok(object),
        _ => Err(AdapterError::model_protocol()),
    }
}

fn validate_relay_ready(frame: &[u8]) -> Result<(), AdapterError> {
    let ready =
        parse_json_strict::<RelayReady>(frame).map_err(|_| AdapterError::model_protocol())?;
    let _ = (ready.version, ready.kind);
    Ok(())
}

async fn read_bounded_relay_frame<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, AdapterError>
where
    R: AsyncBufRead + Unpin,
{
    let mut frame = Vec::new();
    let read = reader
        .take((max_bytes + 2) as u64)
        .read_until(b'\n', &mut frame)
        .await
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    if read == 0 {
        return Ok(None);
    }
    if frame.len() > max_bytes + 1 || frame.last() != Some(&b'\n') {
        return Err(AdapterError::model_protocol());
    }
    frame.pop();
    Ok(Some(frame))
}

pub struct CodeRelay {
    websocket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    relay: Option<UnixStream>,
    callback_origin: String,
    callback_token: Zeroizing<String>,
    binding: AdapterAuthorizationBinding,
    run_id: Uuid,
    client: Client,
    lifecycle: Option<JobLifecycle>,
}

pub struct CodeRelayRun {
    pub relay: CodeRelay,
    pub result: Result<(), AdapterError>,
}

impl CodeRelay {
    pub fn stop_bundle_traffic(&mut self) {
        self.relay.take();
    }

    pub async fn connect(
        callback_origin: String,
        callback_token: Zeroizing<String>,
        binding: AdapterAuthorizationBinding,
        run_id: Uuid,
        relay_fd: OwnedFd,
        deadline: Instant,
    ) -> Result<Self, AdapterError> {
        Self::connect_internal(
            callback_origin,
            callback_token,
            binding,
            run_id,
            relay_fd,
            deadline,
            None,
        )
        .await
    }

    pub async fn connect_with_lifecycle(
        callback_origin: String,
        callback_token: Zeroizing<String>,
        binding: AdapterAuthorizationBinding,
        run_id: Uuid,
        relay_fd: OwnedFd,
        deadline: Instant,
        lifecycle: JobLifecycle,
    ) -> Result<Self, AdapterError> {
        Self::connect_internal(
            callback_origin,
            callback_token,
            binding,
            run_id,
            relay_fd,
            deadline,
            Some(lifecycle),
        )
        .await
    }

    async fn connect_internal(
        callback_origin: String,
        callback_token: Zeroizing<String>,
        binding: AdapterAuthorizationBinding,
        run_id: Uuid,
        relay_fd: OwnedFd,
        deadline: Instant,
        lifecycle: Option<JobLifecycle>,
    ) -> Result<Self, AdapterError> {
        if run_id.is_nil()
            || callback_origin
                .strip_prefix("http://127.0.0.1:")
                .and_then(|port| port.parse::<u16>().ok())
                .is_none_or(|port| port == 0)
        {
            return Err(AdapterError::capability_denied());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AdapterError::timed_out());
        }
        let relay = std::os::unix::net::UnixStream::from(relay_fd);
        relay
            .set_nonblocking(true)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let relay = UnixStream::from_std(relay).map_err(|_| AdapterError::sandbox_unavailable())?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let websocket_url = format!(
            "ws://{}/internal/browser-runs/{}/cdp",
            callback_origin
                .strip_prefix("http://")
                .ok_or_else(AdapterError::capability_denied)?,
            run_id
        );
        let mut request = websocket_url
            .into_client_request()
            .map_err(|_| AdapterError::capability_denied())?;
        let headers = request.headers_mut();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", callback_token.as_str()))
                .map_err(|_| AdapterError::capability_denied())?,
        );
        insert_binding_headers(headers, binding)?;
        let config = WebSocketConfig::default()
            .write_buffer_size(PAUSE_RELAY_QUEUE_BYTES)
            .max_write_buffer_size(MAX_RELAY_QUEUE_BYTES)
            .max_message_size(Some(MAX_RELAY_FRAME_BYTES))
            .max_frame_size(Some(MAX_RELAY_FRAME_BYTES));
        let (mut websocket, response) = tokio::time::timeout(
            remaining,
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| AdapterError::timed_out())?
        .map_err(|_| AdapterError::capability_denied())?;
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            return Err(AdapterError::capability_denied());
        }
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AdapterError::timed_out());
            }
            let message = tokio::time::timeout(remaining, websocket.next())
                .await
                .map_err(|_| AdapterError::timed_out())?;
            match message {
                Some(Ok(Message::Text(frame))) => {
                    validate_relay_ready(frame.as_bytes())?;
                    break;
                }
                Some(Ok(Message::Ping(payload))) => {
                    websocket
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|_| AdapterError::sandbox_unavailable())?;
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Binary(_) | Message::Frame(_) | Message::Close(_)))
                | Some(Err(_))
                | None => return Err(AdapterError::model_protocol()),
            }
        }
        Ok(Self {
            websocket,
            relay: Some(relay),
            callback_origin,
            callback_token,
            binding,
            run_id,
            client,
            lifecycle,
        })
    }

    pub async fn run(
        mut self,
        deadline: Instant,
        mut cancellation: watch::Receiver<bool>,
    ) -> CodeRelayRun {
        let Some(relay) = self.relay.take() else {
            return CodeRelayRun {
                relay: self,
                result: Err(AdapterError::sandbox_unavailable()),
            };
        };
        let (relay_reader, mut relay_writer) = relay.into_split();
        let mut relay_reader = BufReader::new(relay_reader);
        let mut validator = RelayFrameValidator::new();
        let mut bundle_flow = RelayFlowControl::default();
        let mut api_flow = RelayFlowControl::default();
        let result = loop {
            tokio::select! {
                biased;
                changed = cancellation.changed() => {
                    break match changed {
                        Ok(()) if *cancellation.borrow() => Err(AdapterError::cancelled()),
                        _ => Err(AdapterError::model_protocol()),
                    };
                }
                _ = tokio::time::sleep_until(deadline) => {
                    break Err(AdapterError::timed_out());
                }
                read = read_bounded_relay_frame(&mut relay_reader, MAX_RELAY_FRAME_BYTES) => {
                    let frame = match read {
                        Ok(Some(frame)) => frame,
                        Ok(None) => break Ok(()),
                        Err(error) => break Err(error),
                    };
                    if let Err(error) = validator.validate_bundle_frame(&frame) {
                        break Err(error);
                    }
                    let Ok(text) = String::from_utf8(frame) else {
                        break Err(AdapterError::model_protocol());
                    };
                    let bytes = text.len();
                    if let Err(error) = bundle_flow.enqueue(bytes) {
                        break Err(error);
                    }
                    if self.websocket.send(Message::Text(text.into())).await.is_err() {
                        break Err(AdapterError::sandbox_unavailable());
                    }
                    if let Some(lifecycle) = &self.lifecycle {
                        lifecycle.record_callback();
                        lifecycle.record_browser_effect();
                    }
                    if let Err(error) = bundle_flow.complete(bytes) {
                        break Err(error);
                    }
                }
                message = self.websocket.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let bytes = text.as_bytes();
                            if let Err(error) = validator.validate_api_frame(bytes) {
                                break Err(error);
                            }
                            if let Err(error) = api_flow.enqueue(bytes.len()) {
                                break Err(error);
                            }
                            if relay_writer.write_all(bytes).await.is_err()
                                || relay_writer.write_all(b"\n").await.is_err()
                            {
                                break Err(AdapterError::sandbox_unavailable());
                            }
                            if let Err(error) = api_flow.complete(bytes.len()) {
                                break Err(error);
                            }
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if self.websocket.send(Message::Pong(payload)).await.is_err() {
                                break Err(AdapterError::sandbox_unavailable());
                            }
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Close(_))) | None => {
                            break Err(AdapterError::sandbox_unavailable());
                        }
                        Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {
                            break Err(AdapterError::model_protocol());
                        }
                        Some(Err(_)) => break Err(AdapterError::sandbox_unavailable()),
                    }
                }
            }
        };
        relay_writer.shutdown().await.ok();
        CodeRelayRun {
            relay: self,
            result,
        }
    }

    pub async fn close_and_confirm(mut self) -> Result<(), AdapterError> {
        self.stop_bundle_traffic();
        let release_deadline = Instant::now() + RELEASE_TIMEOUT;
        self.websocket.close(None).await.ok();
        let close_wait =
            Duration::from_secs(5).min(release_deadline.saturating_duration_since(Instant::now()));
        let _ = tokio::time::timeout(close_wait, async {
            while let Some(message) = self.websocket.next().await {
                if matches!(message, Ok(Message::Close(_))) {
                    break;
                }
            }
        })
        .await;
        let endpoint = format!(
            "{}/internal/browser-runs/{}/cdp/released",
            self.callback_origin, self.run_id
        );
        for attempt in 0..2 {
            let remaining = release_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AdapterError::sandbox_unavailable());
            }
            let response = self
                .client
                .post(endpoint.clone())
                .timeout(remaining)
                .bearer_auth(self.callback_token.as_str())
                .header(
                    "x-firecrawl-adapter-job-id",
                    self.binding.adapter_job_id.to_string(),
                )
                .header(
                    "x-firecrawl-adapter-supervisor-id",
                    self.binding.adapter_supervisor_id.to_string(),
                )
                .header(
                    "x-firecrawl-adapter-process-id",
                    self.binding.adapter_process_id.to_string(),
                )
                .body(Vec::new())
                .send()
                .await;
            match response {
                Ok(response) if response.status() == StatusCode::NO_CONTENT => return Ok(()),
                Ok(_) => return Err(AdapterError::sandbox_unavailable()),
                Err(_) if attempt == 0 => {}
                Err(_) => return Err(AdapterError::sandbox_unavailable()),
            }
        }
        Err(AdapterError::sandbox_unavailable())
    }
}

fn insert_binding_headers(
    headers: &mut tokio_tungstenite::tungstenite::http::HeaderMap,
    binding: AdapterAuthorizationBinding,
) -> Result<(), AdapterError> {
    for (name, value) in [
        (
            "x-firecrawl-adapter-job-id",
            binding.adapter_job_id.to_string(),
        ),
        (
            "x-firecrawl-adapter-supervisor-id",
            binding.adapter_supervisor_id.to_string(),
        ),
        (
            "x-firecrawl-adapter-process-id",
            binding.adapter_process_id.to_string(),
        ),
    ] {
        headers.insert(
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| AdapterError::model_protocol())?,
            HeaderValue::from_str(&value).map_err(|_| AdapterError::model_protocol())?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncWriteExt, BufReader};

    use super::{
        MAX_RELAY_QUEUE_BYTES, PAUSE_RELAY_QUEUE_BYTES, RESUME_RELAY_QUEUE_BYTES, RelayFlowControl,
        read_bounded_relay_frame, validate_relay_ready,
    };

    #[tokio::test]
    async fn newline_decoder_stops_one_byte_beyond_its_bound() {
        let (mut writer, reader) = tokio::io::duplex(128);
        writer.write_all(&[b'x'; 34]).await.unwrap();
        writer.shutdown().await.unwrap();
        let error = read_bounded_relay_frame(&mut BufReader::new(reader), 32)
            .await
            .unwrap_err();
        assert_eq!(
            error.category,
            crate::redaction::AdapterErrorCategory::ModelProtocolError
        );
    }

    #[tokio::test]
    async fn newline_decoder_accepts_exactly_bounded_frame() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut input = vec![b'x'; 32];
        input.push(b'\n');
        writer.write_all(&input).await.unwrap();
        writer.shutdown().await.unwrap();
        assert_eq!(
            read_bounded_relay_frame(&mut BufReader::new(reader), 32)
                .await
                .unwrap(),
            Some(vec![b'x'; 32])
        );
    }

    #[test]
    fn flow_control_pauses_at_sixteen_and_resumes_at_eight_mib() {
        let mut flow = RelayFlowControl::default();
        flow.enqueue(PAUSE_RELAY_QUEUE_BYTES).unwrap();
        assert!(flow.paused);
        flow.complete(PAUSE_RELAY_QUEUE_BYTES - RESUME_RELAY_QUEUE_BYTES - 1)
            .unwrap();
        assert!(flow.paused);
        flow.complete(RESUME_RELAY_QUEUE_BYTES + 1).unwrap();
        assert!(!flow.paused);
        assert!(flow.enqueue(MAX_RELAY_QUEUE_BYTES + 1).is_err());
    }

    #[test]
    fn relay_ready_frame_is_exact_and_closed() {
        validate_relay_ready(br#"{"version":1,"type":"cdp_relay_ready"}"#).unwrap();
        for invalid in [
            br#"{"version":2,"type":"cdp_relay_ready"}"#.as_slice(),
            br#"{"version":1,"type":"relay_ready"}"#,
            br#"{"version":1,"type":"cdp_relay_ready","extra":true}"#,
            br#"{"version":1,"version":1,"type":"cdp_relay_ready"}"#,
        ] {
            assert!(validate_relay_ready(invalid).is_err());
        }
    }
}
