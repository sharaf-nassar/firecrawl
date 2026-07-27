use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

use crate::action_client::{ActionClient, AdapterAuthorizationBinding};
use crate::app_server::{AppServer, PromptJob, ProtocolBundle};
use crate::broker_client::{
    BrokerCancelReason, BrokerClient, BrokerTerminalOutcome, PreparedCodex, PreparedLeaseMonitor,
};
use crate::config::{AdapterConfig, effective_uid};
use crate::observations::ObservationV1;
use crate::protocol::{VersionOne, parse_json_strict};
use crate::redaction::{AdapterError, AdapterErrorCategory};

const MAX_TERMINAL_METADATA: usize = 128;
const MAX_ADAPTER_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_AUTHORIZATION_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobKind {
    Prompt,
    Code,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JobState {
    Preparing,
    Prepared,
    Authorized,
    Starting,
    Running,
}

#[derive(Debug)]
struct JobEntry {
    adapter_job_id: Uuid,
    adapter_supervisor_id: Uuid,
    binding: Option<AdapterAuthorizationBinding>,
    kind: JobKind,
    state: JobState,
    cancel: watch::Sender<bool>,
    completion: watch::Sender<bool>,
    cancellation_requested: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalJob {
    pub run_id: Uuid,
    pub adapter_job_id: Uuid,
    pub category: Option<AdapterErrorCategory>,
}

#[derive(Debug, Default)]
struct RegistryState {
    active_by_run: BTreeMap<Uuid, JobEntry>,
    run_by_job: BTreeMap<Uuid, Uuid>,
    terminal: VecDeque<TerminalJob>,
}

#[derive(Clone, Debug)]
pub struct JobRegistry {
    inner: Arc<Mutex<RegistryState>>,
    max_prompt_runs: usize,
    max_code_runs: usize,
}

#[derive(Debug)]
pub struct AdmittedJob {
    pub binding: AdapterAuthorizationBinding,
    pub cancellation: watch::Receiver<bool>,
    pub completion: watch::Receiver<bool>,
}

#[derive(Debug)]
pub struct ReservedJob {
    pub cancellation: watch::Receiver<bool>,
    pub completion: watch::Receiver<bool>,
}

struct RegistryCompletionGuard {
    registry: JobRegistry,
    run_id: Uuid,
    adapter_job_id: Uuid,
}

impl Drop for RegistryCompletionGuard {
    fn drop(&mut self) {
        self.registry.complete_reserved(
            self.run_id,
            self.adapter_job_id,
            Some(AdapterErrorCategory::SandboxUnavailable),
        );
    }
}

impl JobRegistry {
    pub fn new(max_prompt_runs: usize, max_code_runs: usize) -> Result<Self, AdapterError> {
        if max_prompt_runs != 1 || max_code_runs != 2 {
            return Err(AdapterError::model_protocol());
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(RegistryState::default())),
            max_prompt_runs,
            max_code_runs,
        })
    }

    pub fn admit(
        &self,
        run_id: Uuid,
        kind: JobKind,
        binding: AdapterAuthorizationBinding,
    ) -> Result<AdmittedJob, AdapterError> {
        let reserved = self.reserve(
            run_id,
            kind,
            binding.adapter_job_id,
            binding.adapter_supervisor_id,
        )?;
        self.bind_prepared(run_id, binding)?;
        Ok(AdmittedJob {
            binding,
            cancellation: reserved.cancellation,
            completion: reserved.completion,
        })
    }

    pub fn reserve(
        &self,
        run_id: Uuid,
        kind: JobKind,
        adapter_job_id: Uuid,
        adapter_supervisor_id: Uuid,
    ) -> Result<ReservedJob, AdapterError> {
        if run_id.is_nil() || adapter_job_id.is_nil() || adapter_supervisor_id.is_nil() {
            return Err(AdapterError::model_protocol());
        }
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AdapterError::model_protocol())?;
        if registry.active_by_run.contains_key(&run_id)
            || registry.run_by_job.contains_key(&adapter_job_id)
        {
            return Err(AdapterError::model_protocol());
        }
        let active_kind = registry
            .active_by_run
            .values()
            .filter(|entry| entry.kind == kind)
            .count();
        let maximum = match kind {
            JobKind::Prompt => self.max_prompt_runs,
            JobKind::Code => self.max_code_runs,
        };
        if active_kind >= maximum {
            return Err(match kind {
                JobKind::Prompt => AdapterError::codex_unavailable(),
                JobKind::Code => AdapterError::sandbox_unavailable(),
            });
        }
        let (cancel, cancellation) = watch::channel(false);
        let (completion_sender, completion) = watch::channel(false);
        registry.run_by_job.insert(adapter_job_id, run_id);
        registry.active_by_run.insert(
            run_id,
            JobEntry {
                adapter_job_id,
                adapter_supervisor_id,
                binding: None,
                kind,
                state: JobState::Preparing,
                cancel,
                completion: completion_sender,
                cancellation_requested: false,
            },
        );
        Ok(ReservedJob {
            cancellation,
            completion,
        })
    }

    pub fn bind_prepared(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
    ) -> Result<(), AdapterError> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AdapterError::model_protocol())?;
        let entry = registry
            .active_by_run
            .get_mut(&run_id)
            .ok_or_else(AdapterError::model_protocol)?;
        if entry.state != JobState::Preparing
            || entry.adapter_job_id != binding.adapter_job_id
            || entry.adapter_supervisor_id != binding.adapter_supervisor_id
            || entry.binding.is_some()
        {
            return Err(AdapterError::model_protocol());
        }
        entry.binding = Some(binding);
        entry.state = JobState::Prepared;
        Ok(())
    }

    pub fn authorize(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
    ) -> Result<(), AdapterError> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AdapterError::model_protocol())?;
        let entry = registry
            .active_by_run
            .get_mut(&run_id)
            .ok_or_else(AdapterError::model_protocol)?;
        if entry.state != JobState::Prepared || entry.binding != Some(binding) {
            return Err(AdapterError::model_protocol());
        }
        entry.state = JobState::Authorized;
        Ok(())
    }

    pub fn mark_running(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
    ) -> Result<(), AdapterError> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AdapterError::model_protocol())?;
        let entry = registry
            .active_by_run
            .get_mut(&run_id)
            .ok_or_else(AdapterError::model_protocol)?;
        if entry.state != JobState::Starting || entry.binding != Some(binding) {
            return Err(AdapterError::model_protocol());
        }
        if entry.cancellation_requested {
            return Err(AdapterError::cancelled());
        }
        entry.state = JobState::Running;
        Ok(())
    }

    pub fn begin_start(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
    ) -> Result<(), AdapterError> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AdapterError::model_protocol())?;
        let entry = registry
            .active_by_run
            .get_mut(&run_id)
            .ok_or_else(AdapterError::model_protocol)?;
        if entry.state != JobState::Authorized || entry.binding != Some(binding) {
            return Err(AdapterError::model_protocol());
        }
        if entry.cancellation_requested {
            return Err(AdapterError::cancelled());
        }
        entry.state = JobState::Starting;
        Ok(())
    }

    pub fn request_cancel(&self, run_id: Uuid) -> Result<watch::Receiver<bool>, AdapterError> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| AdapterError::model_protocol())?;
        let entry = registry
            .active_by_run
            .get_mut(&run_id)
            .ok_or_else(AdapterError::cancelled)?;
        if !entry.cancellation_requested {
            entry.cancellation_requested = true;
            let _ = entry.cancel.send(true);
        }
        Ok(entry.completion.subscribe())
    }

    pub fn complete(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
        category: Option<AdapterErrorCategory>,
    ) -> bool {
        let Ok(registry) = self.inner.lock() else {
            return false;
        };
        let Some(entry) = registry.active_by_run.get(&run_id) else {
            return false;
        };
        if entry.binding != Some(binding) {
            return false;
        }
        drop(registry);
        self.complete_reserved(run_id, binding.adapter_job_id, category)
    }

    pub fn complete_reserved(
        &self,
        run_id: Uuid,
        adapter_job_id: Uuid,
        category: Option<AdapterErrorCategory>,
    ) -> bool {
        let Ok(mut registry) = self.inner.lock() else {
            return false;
        };
        let Some(entry) = registry.active_by_run.get(&run_id) else {
            return false;
        };
        if entry.adapter_job_id != adapter_job_id {
            return false;
        }
        let Some(entry) = registry.active_by_run.remove(&run_id) else {
            return false;
        };
        let _ = entry.completion.send(true);
        registry.run_by_job.remove(&entry.adapter_job_id);
        push_terminal(
            &mut registry,
            TerminalJob {
                run_id,
                adapter_job_id,
                category,
            },
        );
        true
    }

    pub fn active_count(&self) -> usize {
        self.inner
            .lock()
            .map(|registry| registry.active_by_run.len())
            .unwrap_or_default()
    }

    pub fn terminal_jobs(&self) -> Vec<TerminalJob> {
        self.inner
            .lock()
            .map(|registry| registry.terminal.iter().copied().collect())
            .unwrap_or_default()
    }
}

fn push_terminal(registry: &mut RegistryState, terminal: TerminalJob) {
    registry.terminal.push_back(terminal);
    while registry.terminal.len() > MAX_TERMINAL_METADATA {
        registry.terminal.pop_front();
    }
}

fn apply_broker_terminal_outcome<T>(
    run_result: Result<T, AdapterError>,
    outcome: BrokerTerminalOutcome,
) -> Result<T, AdapterError> {
    match outcome {
        BrokerTerminalOutcome::Completed => run_result,
        BrokerTerminalOutcome::Cancelled => Err(AdapterError::cancelled()),
        BrokerTerminalOutcome::TimedOut => Err(AdapterError::timed_out()),
        BrokerTerminalOutcome::Failed => run_result.and(Err(AdapterError::sandbox_unavailable())),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PromptLoopPolicy {
    pub max_prompt_characters: usize,
    pub max_snapshot_excerpt_characters: usize,
    pub max_observation_bytes: usize,
    pub max_aggregate_observation_bytes: usize,
    pub max_final_output_bytes: usize,
    pub max_actions: u8,
    pub max_turns: u8,
    pub max_runtime_ms: u64,
}

impl PromptLoopPolicy {
    pub fn validate(&self) -> Result<(), AdapterError> {
        if (
            self.max_prompt_characters,
            self.max_snapshot_excerpt_characters,
            self.max_observation_bytes,
            self.max_aggregate_observation_bytes,
            self.max_final_output_bytes,
            self.max_actions,
            self.max_turns,
            self.max_runtime_ms,
        ) != (10_000, 40_000, 65_536, 1_048_576, 262_144, 25, 26, 300_000)
        {
            return Err(AdapterError::model_protocol());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PromptRequestBody {
    pub adapter_job_id: Uuid,
    pub adapter_supervisor_id: Uuid,
    pub capability_token: String,
    pub run_id: Uuid,
    pub prompt: String,
    pub initial_observation: ObservationV1,
    pub model: String,
    pub reasoning_effort: String,
    pub decision_schema_version: u8,
    pub observation_schema_version: u8,
    pub loop_policy: PromptLoopPolicy,
    pub deadline: String,
    pub correlation_id: Uuid,
}

impl PromptRequestBody {
    pub fn validate(&self) -> Result<(), AdapterError> {
        if self.adapter_job_id.is_nil()
            || self.adapter_supervisor_id.is_nil()
            || self.run_id.is_nil()
            || self.correlation_id.is_nil()
            || self.capability_token.len() != 43
            || !self
                .capability_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || self.prompt.chars().count() > 10_000
            || self.model != "gpt-5.6-terra"
            || self.reasoning_effort != "medium"
            || self.decision_schema_version != 1
            || self.observation_schema_version != 1
            || self.deadline.is_empty()
            || !matches!(
                self.initial_observation,
                ObservationV1::Initial { sequence: 0, .. }
            )
        {
            return Err(AdapterError::model_protocol());
        }
        self.initial_observation
            .validate()
            .map_err(|_| AdapterError::model_protocol())?;
        self.loop_policy.validate()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeRequestBody {
    pub adapter_job_id: Uuid,
    pub adapter_supervisor_id: Uuid,
    pub capability_token: String,
    pub run_id: Uuid,
    pub language: CodeLanguage,
    pub source: String,
    pub deadline: String,
    pub correlation_id: Uuid,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CodeLanguage {
    Node,
    Python,
    Bash,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelRequestBody {
    pub run_id: Uuid,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdapterRequest {
    ExecutePrompt {
        version: VersionOne,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        body: Box<PromptRequestBody>,
    },
    ExecuteCode {
        version: VersionOne,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        body: CodeRequestBody,
    },
    Cancel {
        version: VersionOne,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        body: CancelRequestBody,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationAck {
    pub version: VersionOne,
    #[serde(rename = "requestId")]
    pub request_id: Uuid,
    #[serde(rename = "type")]
    pub kind: AuthorizationAckType,
    pub binding: AuthorizationBindingWire,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum AuthorizationAckType {
    #[serde(rename = "authorized")]
    Authorized,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthorizationBindingWire {
    pub adapter_job_id: Uuid,
    pub adapter_supervisor_id: Uuid,
    pub adapter_process_id: u32,
}

impl From<AdapterAuthorizationBinding> for AuthorizationBindingWire {
    fn from(binding: AdapterAuthorizationBinding) -> Self {
        Self {
            adapter_job_id: binding.adapter_job_id,
            adapter_supervisor_id: binding.adapter_supervisor_id,
            adapter_process_id: binding.adapter_process_id,
        }
    }
}

impl TryFrom<AuthorizationBindingWire> for AdapterAuthorizationBinding {
    type Error = AdapterError;

    fn try_from(binding: AuthorizationBindingWire) -> Result<Self, Self::Error> {
        AdapterAuthorizationBinding::new(
            binding.adapter_job_id,
            binding.adapter_supervisor_id,
            binding.adapter_process_id,
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AdapterResponse<T>
where
    T: Serialize,
{
    Accepted {
        version: VersionOne,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        binding: AuthorizationBindingWire,
    },
    Result {
        version: VersionOne,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        body: T,
    },
    Error {
        version: VersionOne,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        error: AdapterError,
    },
}

#[derive(Clone)]
pub struct AdapterService {
    config: AdapterConfig,
    broker: BrokerClient,
    registry: JobRegistry,
    protocol: ProtocolBundle,
    boot_id: Option<Uuid>,
}

impl AdapterService {
    pub fn new(config: AdapterConfig) -> Result<Self, AdapterError> {
        let protocol = ProtocolBundle::load(&config.protocol_root)?;
        let broker = BrokerClient::new(config.broker_socket.clone())?;
        let registry = JobRegistry::new(config.max_prompt_runs, config.max_code_runs)?;
        Ok(Self {
            config,
            broker,
            registry,
            protocol,
            boot_id: None,
        })
    }

    pub fn with_dependencies(
        config: AdapterConfig,
        broker: BrokerClient,
        registry: JobRegistry,
        protocol: ProtocolBundle,
    ) -> Self {
        Self {
            config,
            broker,
            registry,
            protocol,
            boot_id: Some(Uuid::new_v4()),
        }
    }

    pub async fn serve(mut self) -> Result<(), AdapterError> {
        let boot_id_file = self.config.boot_id_file();
        let prior_boot_id = read_prior_boot_id(&boot_id_file)?;
        if let Some(prior_boot_id) = prior_boot_id {
            let broker = self.broker.clone();
            tokio::task::spawn_blocking(move || broker.cancel_owner(prior_boot_id))
                .await
                .map_err(|_| AdapterError::sandbox_unavailable())??;
        }
        let boot_id = Uuid::new_v4();
        publish_boot_id(&boot_id_file, boot_id)?;
        self.boot_id = Some(boot_id);
        prepare_adapter_socket(&self.config.adapter_socket)?;
        let listener = UnixListener::bind(&self.config.adapter_socket)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        fs::set_permissions(
            &self.config.adapter_socket,
            fs::Permissions::from_mode(0o600),
        )
        .map_err(|_| AdapterError::sandbox_unavailable())?;
        let metadata = fs::symlink_metadata(&self.config.adapter_socket)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        if !metadata.file_type().is_socket()
            || metadata.file_type().is_symlink()
            || metadata.mode() & 0o777 != 0o600
            || metadata.uid() != effective_uid()?
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        loop {
            let (stream, _) = listener
                .accept()
                .await
                .map_err(|_| AdapterError::sandbox_unavailable())?;
            let service = self.clone();
            tokio::spawn(async move {
                let _ = service.handle_connection(stream).await;
            });
        }
    }

    #[doc(hidden)]
    pub async fn handle_connection(&self, stream: UnixStream) -> Result<(), AdapterError> {
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let request_line = read_bounded_line(&mut reader).await?;
        let request: AdapterRequest =
            parse_json_strict(&request_line).map_err(|_| AdapterError::model_protocol())?;
        match request {
            AdapterRequest::ExecutePrompt {
                request_id, body, ..
            } => {
                self.execute_prompt(request_id, *body, &mut reader, &mut writer)
                    .await
            }
            AdapterRequest::ExecuteCode {
                request_id, body, ..
            } => {
                let _ = body;
                write_response(
                    &mut writer,
                    &AdapterResponse::<Value>::Error {
                        version: VersionOne,
                        request_id,
                        error: AdapterError::sandbox_unavailable(),
                    },
                )
                .await
            }
            AdapterRequest::Cancel {
                request_id, body, ..
            } => self.cancel(request_id, body, &mut writer).await,
        }
    }

    async fn execute_prompt(
        &self,
        request_id: Uuid,
        body: PromptRequestBody,
        reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        body.validate()?;
        let (deadline_unix_ms, deadline) = parse_deadline(&body.deadline)?;
        let reserved = self.registry.reserve(
            body.run_id,
            JobKind::Prompt,
            body.adapter_job_id,
            body.adapter_supervisor_id,
        )?;
        let mut cancellation = reserved.cancellation;
        let _completion_guard = RegistryCompletionGuard {
            registry: self.registry.clone(),
            run_id: body.run_id,
            adapter_job_id: body.adapter_job_id,
        };
        let broker = self.broker.clone();
        let job_id = body.adapter_job_id;
        let adapter_boot_id = self.boot_id.ok_or_else(AdapterError::sandbox_unavailable)?;
        let auth_file = self.config.codex_auth_file.clone();
        let correlation_id = body.correlation_id;
        let mut prepare_task = tokio::task::spawn_blocking(move || {
            broker.prepare_codex(
                job_id,
                adapter_boot_id,
                correlation_id,
                deadline_unix_ms,
                &auth_file,
            )
        });
        let prepared_result = tokio::select! {
            result = &mut prepare_task => {
                result.map_err(|_| AdapterError::codex_unavailable())?
            }
            changed = cancellation.changed() => {
                let cancellation_error = match changed {
                    Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                    _ => AdapterError::model_protocol(),
                };
                if let Ok(mut prepared) = prepare_task
                    .await
                    .map_err(|_| AdapterError::codex_unavailable())?
                {
                    self.abort_prepared(&mut prepared, BrokerCancelReason::Cancelled).await;
                }
                self.registry.complete_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    Some(cancellation_error.category),
                );
                return Err(cancellation_error);
            }
        };
        let mut prepared = prepared_result?;
        let binding = AdapterAuthorizationBinding::new(
            body.adapter_job_id,
            body.adapter_supervisor_id,
            prepared.init_pid,
        )?;
        if let Err(error) = self.registry.bind_prepared(body.run_id, binding) {
            self.abort_prepared(&mut prepared, BrokerCancelReason::ProtocolError)
                .await;
            return Err(error);
        }
        if *cancellation.borrow() {
            self.abort_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::Cancelled,
                Some(AdapterErrorCategory::Cancelled),
            )
            .await;
            return Err(AdapterError::cancelled());
        }
        let callback_token = match self.config.read_callback_token() {
            Ok(token) => token,
            Err(error) => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await;
                return Err(error);
            }
        };
        let action_client = match ActionClient::new(
            self.config.callback_url.clone(),
            callback_token,
            binding,
            body.run_id,
        ) {
            Ok(client) => client,
            Err(error) => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await;
                return Err(error);
            }
        };
        let (stdout, stdin, stderr) = match (
            prepared.stdout.take(),
            prepared.stdin.take(),
            prepared.stderr.take(),
        ) {
            (Some(stdout), Some(stdin), Some(stderr)) => (stdout, stdin, stderr),
            _ => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(AdapterErrorCategory::SandboxUnavailable),
                )
                .await;
                return Err(AdapterError::sandbox_unavailable());
            }
        };
        let payload_started = Arc::new(AtomicBool::new(false));
        let stdout = AuditedReader::new(
            stdout,
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
            payload_started.clone(),
        );
        let stderr = AuditedReader::new(
            stderr,
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
            payload_started,
        );
        let mut app_server = AppServer::new(stdout, stdin, stderr);
        let lease_monitor = match self.broker.monitor_prepared(&prepared) {
            Ok(monitor) => monitor,
            Err(error) => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await;
                return Err(error);
            }
        };
        emit_lifecycle(
            "broker_prepared",
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
        );
        if let Err(error) = write_response(
            writer,
            &AdapterResponse::<Value>::Accepted {
                version: VersionOne,
                request_id,
                binding: binding.into(),
            },
        )
        .await
        {
            drop(lease_monitor);
            self.abort_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::AuthorizationFailed,
                Some(AdapterErrorCategory::Cancelled),
            )
            .await;
            return Err(error);
        }
        let authorization_deadline = deadline.min(Instant::now() + MAX_AUTHORIZATION_WAIT);
        let acknowledgement = read_authorization_frame(
            reader,
            authorization_deadline,
            &mut cancellation,
            &lease_monitor,
        )
        .await
        .and_then(|line| {
            parse_json_strict::<AuthorizationAck>(&line).map_err(|_| AdapterError::model_protocol())
        });
        drop(lease_monitor);
        let acknowledgement = match acknowledgement {
            Ok(acknowledgement)
                if acknowledgement.request_id == request_id
                    && AdapterAuthorizationBinding::try_from(acknowledgement.binding)
                        .is_ok_and(|acknowledged| acknowledged == binding) =>
            {
                acknowledgement
            }
            Ok(_) => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::AuthorizationFailed,
                    Some(AdapterErrorCategory::ModelProtocolError),
                )
                .await;
                return Err(AdapterError::model_protocol());
            }
            Err(error) => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::AuthorizationFailed,
                    Some(error.category),
                )
                .await;
                return Err(error);
            }
        };
        let _ = acknowledgement;
        if *cancellation.borrow() {
            self.abort_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::Cancelled,
                Some(AdapterErrorCategory::Cancelled),
            )
            .await;
            return Err(AdapterError::cancelled());
        }
        if let Err(error) = self.broker.ensure_prepared_lease_quiet(&prepared) {
            self.abort_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::ProtocolError,
                Some(error.category),
            )
            .await;
            return Err(error);
        }
        if let Err(error) = self.registry.authorize(body.run_id, binding) {
            self.abort_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::ProtocolError,
                Some(error.category),
            )
            .await;
            return Err(error);
        }
        emit_lifecycle(
            "api_authorized",
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
        );
        if let Err(error) = self.registry.begin_start(body.run_id, binding) {
            let reason = if error.category == AdapterErrorCategory::Cancelled {
                BrokerCancelReason::Cancelled
            } else {
                BrokerCancelReason::ProtocolError
            };
            self.abort_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                reason,
                Some(error.category),
            )
            .await;
            return Err(error);
        }
        let start_interrupter = match self.broker.start_interrupter(&prepared) {
            Ok(interrupter) => interrupter,
            Err(error) => {
                self.abort_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await;
                return Err(error);
            }
        };
        let broker = self.broker.clone();
        let mut start_task = tokio::task::spawn_blocking(move || {
            let mut prepared = prepared;
            let result = broker.start(&mut prepared);
            (prepared, result)
        });
        enum StartWait {
            Completed(Result<(PreparedCodex, Result<(), AdapterError>), tokio::task::JoinError>),
            Interrupted(AdapterError),
        }
        let start_wait = tokio::select! {
            biased;
            result = &mut start_task => StartWait::Completed(result),
            _ = tokio::time::sleep_until(deadline) => {
                StartWait::Interrupted(AdapterError::timed_out())
            }
            changed = cancellation.changed() => {
                let error = match changed {
                    Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                    _ => AdapterError::model_protocol(),
                };
                StartWait::Interrupted(error)
            }
        };
        match start_wait {
            StartWait::Completed(result) => {
                drop(start_interrupter);
                let (returned, result) = result.map_err(|_| AdapterError::sandbox_unavailable())?;
                prepared = returned;
                if let Err(error) = result {
                    self.registry
                        .complete(body.run_id, binding, Some(error.category));
                    return Err(error);
                }
            }
            StartWait::Interrupted(error) => {
                let _ = start_interrupter.interrupt();
                if let Ok((mut returned, _)) = start_task.await {
                    returned.control.take();
                }
                self.registry
                    .complete(body.run_id, binding, Some(error.category));
                return Err(error);
            }
        }
        emit_lifecycle(
            "broker_started",
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
        );
        let mut run_result = match self.registry.mark_running(body.run_id, binding) {
            Ok(()) => {
                app_server
                    .run_prompt_job(
                        &self.protocol,
                        PromptJob {
                            prompt: body.prompt,
                            initial_observation: body.initial_observation,
                            deadline,
                        },
                        |sequence, operation| {
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            action_client.execute(sequence, operation, remaining)
                        },
                        cancellation,
                    )
                    .await
            }
            Err(error) => Err(error),
        };
        let reason = match &run_result {
            Ok(_) => BrokerCancelReason::Shutdown,
            Err(error) if error.category == AdapterErrorCategory::TimedOut => {
                BrokerCancelReason::TimedOut
            }
            Err(error) if error.category == AdapterErrorCategory::Cancelled => {
                BrokerCancelReason::Cancelled
            }
            Err(_) => BrokerCancelReason::ProtocolError,
        };
        let broker = self.broker.clone();
        let cleanup = tokio::task::spawn_blocking(move || {
            broker.finish(&mut prepared, adapter_boot_id, reason)
        })
        .await
        .map_err(|_| AdapterError::sandbox_unavailable())
        .and_then(|result| result);
        let terminal_outcome = match cleanup {
            Ok(terminal) => {
                let outcome = terminal.outcome;
                let _artifacts = terminal.artifacts;
                run_result = apply_broker_terminal_outcome(run_result, outcome);
                Some(outcome)
            }
            Err(error) => {
                run_result = Err(error);
                None
            }
        };
        if terminal_outcome == Some(BrokerTerminalOutcome::Completed)
            && let Err(error) = app_server
                .verify_terminated_stdout(Instant::now() + MAX_AUTHORIZATION_WAIT)
                .await
            && run_result.is_ok()
        {
            run_result = Err(error);
        }
        let category = run_result.as_ref().err().map(|error| error.category);
        self.registry.complete(body.run_id, binding, category);
        match run_result {
            Ok(result) => {
                let body =
                    serde_json::to_value(result).map_err(|_| AdapterError::model_protocol())?;
                write_response(
                    writer,
                    &AdapterResponse::Result {
                        version: VersionOne,
                        request_id,
                        body,
                    },
                )
                .await
            }
            Err(error) => {
                write_response(
                    writer,
                    &AdapterResponse::<Value>::Error {
                        version: VersionOne,
                        request_id,
                        error,
                    },
                )
                .await
            }
        }
    }

    async fn cancel(
        &self,
        request_id: Uuid,
        body: CancelRequestBody,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        if body.run_id.is_nil()
            || body.reason.is_empty()
            || body.reason.len() > 256
            || body.reason.trim() != body.reason
            || body.reason.chars().any(char::is_control)
        {
            return Err(AdapterError::model_protocol());
        }
        let mut completion = self.registry.request_cancel(body.run_id)?;
        if !*completion.borrow() {
            tokio::time::timeout(MAX_AUTHORIZATION_WAIT, completion.changed())
                .await
                .map_err(|_| AdapterError::timed_out())?
                .map_err(|_| AdapterError::sandbox_unavailable())?;
        }
        write_response(
            writer,
            &AdapterResponse::Result {
                version: VersionOne,
                request_id,
                body: json!({"killed": true}),
            },
        )
        .await
    }

    async fn abort_prepared(&self, prepared: &mut PreparedCodex, reason: BrokerCancelReason) {
        let broker = self.broker.clone();
        let mut owned = PreparedCodex {
            job_id: prepared.job_id,
            init_pid: prepared.init_pid,
            stdin: prepared.stdin.take(),
            stdout: prepared.stdout.take(),
            stderr: prepared.stderr.take(),
            control: prepared.control.take(),
            started: false,
        };
        let _ = tokio::task::spawn_blocking(move || broker.abort(&mut owned, reason)).await;
    }

    async fn abort_and_complete(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
        category: Option<AdapterErrorCategory>,
    ) {
        self.abort_prepared(prepared, reason).await;
        self.registry.complete(run_id, binding, category);
    }
}

async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<u8>, AdapterError> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|_| AdapterError::model_protocol())?;
        if buffer.is_empty() {
            return Err(AdapterError::model_protocol());
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |position| position + 1);
        line.len()
            .checked_add(end)
            .filter(|length| *length <= MAX_ADAPTER_LINE_BYTES)
            .ok_or_else(AdapterError::model_protocol)?;
        line.extend_from_slice(&buffer[..end]);
        reader.consume(end);
        if line.last() == Some(&b'\n') {
            break;
        }
    }
    if line.pop() != Some(b'\n') || line.is_empty() || line.contains(&b'\n') {
        return Err(AdapterError::model_protocol());
    }
    Ok(line)
}

async fn read_authorization_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    deadline: Instant,
    cancellation: &mut watch::Receiver<bool>,
    lease_monitor: &PreparedLeaseMonitor,
) -> Result<Vec<u8>, AdapterError> {
    let mut frame = Vec::new();
    loop {
        if *cancellation.borrow() {
            return Err(AdapterError::cancelled());
        }
        let chunk = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Err(AdapterError::timed_out()),
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return Err(AdapterError::cancelled());
                }
                continue;
            }
            failure = lease_monitor.wait_for_failure() => return Err(failure),
            buffer = reader.fill_buf() => {
                let buffer = buffer.map_err(|_| AdapterError::model_protocol())?;
                if buffer.is_empty() {
                    break;
                }
                buffer.to_vec()
            }
        };
        reader.consume(chunk.len());
        frame
            .len()
            .checked_add(chunk.len())
            .filter(|length| *length <= MAX_ADAPTER_LINE_BYTES + 1)
            .ok_or_else(AdapterError::model_protocol)?;
        frame.extend_from_slice(&chunk);
    }
    if frame.len() < 2
        || frame.pop() != Some(b'\n')
        || frame.contains(&b'\n')
        || frame.len() > MAX_ADAPTER_LINE_BYTES
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(frame)
}

async fn write_response<T: Serialize>(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    response: &AdapterResponse<T>,
) -> Result<(), AdapterError> {
    let mut frame = serde_json::to_vec(response).map_err(|_| AdapterError::model_protocol())?;
    if frame.len() >= MAX_ADAPTER_LINE_BYTES {
        return Err(AdapterError::model_protocol());
    }
    frame.push(b'\n');
    writer
        .write_all(&frame)
        .await
        .map_err(|_| AdapterError::model_protocol())?;
    writer
        .flush()
        .await
        .map_err(|_| AdapterError::model_protocol())
}

fn prepare_adapter_socket(path: &Path) -> Result<(), AdapterError> {
    if !path.is_absolute() {
        return Err(AdapterError::sandbox_unavailable());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_socket()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == effective_uid()? =>
        {
            fs::remove_file(path).map_err(|_| AdapterError::sandbox_unavailable())
        }
        Ok(_) => Err(AdapterError::sandbox_unavailable()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AdapterError::sandbox_unavailable()),
    }
}

fn parse_deadline(value: &str) -> Result<(u64, Instant), AdapterError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return Err(AdapterError::model_protocol());
    }
    let number = |range: std::ops::Range<usize>| -> Result<i64, AdapterError> {
        std::str::from_utf8(&bytes[range])
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(AdapterError::model_protocol)
    };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    let millisecond = number(20..23)?;
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return Err(AdapterError::model_protocol());
    }
    let days = days_from_civil(year, month, day);
    let unix_ms = days
        .checked_mul(86_400_000)
        .and_then(|value| value.checked_add(hour * 3_600_000))
        .and_then(|value| value.checked_add(minute * 60_000))
        .and_then(|value| value.checked_add(second * 1_000))
        .and_then(|value| value.checked_add(millisecond))
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(AdapterError::model_protocol)?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AdapterError::model_protocol())?
        .as_millis() as u64;
    let remaining_ms = unix_ms
        .checked_sub(now_ms)
        .filter(|remaining| (1..=300_000).contains(remaining))
        .ok_or_else(AdapterError::timed_out)?;
    Ok((
        unix_ms,
        Instant::now() + Duration::from_millis(remaining_ms),
    ))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn emit_lifecycle(event: &str, correlation_id: Uuid, job_id: Uuid, init_pid: u32) {
    let record = json!({
        "event": event,
        "correlationId": correlation_id,
        "jobId": job_id,
        "hostInitPid": init_pid,
    });
    eprintln!("{record}");
}

fn read_prior_boot_id(path: &Path) -> Result<Option<Uuid>, AdapterError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AdapterError::sandbox_unavailable()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o777 != 0o600
        || metadata.uid() != effective_uid()?
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let value = fs::read_to_string(path).map_err(|_| AdapterError::sandbox_unavailable())?;
    if !value.ends_with('\n') || value.lines().count() != 1 {
        return Err(AdapterError::sandbox_unavailable());
    }
    let boot_id =
        Uuid::parse_str(value.trim_end()).map_err(|_| AdapterError::sandbox_unavailable())?;
    if boot_id.is_nil() {
        return Err(AdapterError::sandbox_unavailable());
    }
    Ok(Some(boot_id))
}

fn publish_boot_id(path: &Path, boot_id: Uuid) -> Result<(), AdapterError> {
    let parent = path
        .parent()
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    let parent_metadata =
        fs::symlink_metadata(parent).map_err(|_| AdapterError::sandbox_unavailable())?;
    if !parent_metadata.is_dir()
        || parent_metadata.file_type().is_symlink()
        || parent_metadata.mode() & 0o022 != 0
        || parent_metadata.uid() != effective_uid()?
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let temporary = parent.join(format!(".adapter.boot-id.{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let result = (|| {
        writeln!(file, "{boot_id}").map_err(|_| AdapterError::sandbox_unavailable())?;
        file.sync_all()
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        fs::rename(&temporary, path).map_err(|_| AdapterError::sandbox_unavailable())?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| AdapterError::sandbox_unavailable())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

struct AuditedReader<R> {
    inner: R,
    correlation_id: Uuid,
    job_id: Uuid,
    init_pid: u32,
    emitted: Arc<AtomicBool>,
}

impl<R> AuditedReader<R> {
    fn new(
        inner: R,
        correlation_id: Uuid,
        job_id: Uuid,
        init_pid: u32,
        emitted: Arc<AtomicBool>,
    ) -> Self {
        Self {
            inner,
            correlation_id,
            job_id,
            init_pid,
            emitted,
        }
    }
}

impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for AuditedReader<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = std::pin::Pin::new(&mut self.inner).poll_read(context, buffer);
        if matches!(result, std::task::Poll::Ready(Ok(())))
            && buffer.filled().len() > before
            && self
                .emitted
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            emit_lifecycle(
                "payload_started",
                self.correlation_id,
                self.job_id,
                self.init_pid,
            );
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::{
        JobKind, JobRegistry, apply_broker_terminal_outcome, publish_boot_id, read_prior_boot_id,
    };
    use crate::action_client::AdapterAuthorizationBinding;
    use crate::broker_client::BrokerTerminalOutcome;
    use crate::redaction::{AdapterError, AdapterErrorCategory};
    use uuid::Uuid;

    #[test]
    fn registry_rejects_duplicate_active_identity_and_cancel_wins() {
        let registry = JobRegistry::new(1, 2).unwrap();
        let run_id = Uuid::new_v4();
        let binding = AdapterAuthorizationBinding::new(Uuid::new_v4(), Uuid::new_v4(), 7).unwrap();
        let admitted = registry.admit(run_id, JobKind::Prompt, binding).unwrap();
        assert!(registry.admit(run_id, JobKind::Prompt, binding).is_err());
        registry.authorize(run_id, binding).unwrap();
        registry.begin_start(run_id, binding).unwrap();
        registry.mark_running(run_id, binding).unwrap();
        let completion = registry.request_cancel(run_id).unwrap();
        assert!(*admitted.cancellation.borrow());
        assert!(!*completion.borrow());
        assert!(registry.request_cancel(run_id).is_ok());
        assert!(registry.complete(
            run_id,
            binding,
            Some(crate::redaction::AdapterErrorCategory::Cancelled),
        ));
        assert!(*completion.borrow());
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn broker_terminal_outcome_is_authoritative_over_local_success() {
        for (outcome, expected) in [
            (
                BrokerTerminalOutcome::Cancelled,
                AdapterErrorCategory::Cancelled,
            ),
            (
                BrokerTerminalOutcome::TimedOut,
                AdapterErrorCategory::TimedOut,
            ),
            (
                BrokerTerminalOutcome::Failed,
                AdapterErrorCategory::SandboxUnavailable,
            ),
        ] {
            let result = apply_broker_terminal_outcome::<()>(Ok(()), outcome).unwrap_err();
            assert_eq!(result.category, expected);
        }
        let local_error = AdapterError::model_protocol();
        assert_eq!(
            apply_broker_terminal_outcome::<()>(
                Err(local_error.clone()),
                BrokerTerminalOutcome::Failed,
            )
            .unwrap_err(),
            local_error
        );
    }

    #[test]
    fn boot_id_is_published_atomically_with_private_mode() {
        let root = std::env::temp_dir().join(format!("firecrawl-boot-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("adapter.boot-id");
        assert_eq!(read_prior_boot_id(&path).unwrap(), None);
        let boot_id = Uuid::new_v4();
        publish_boot_id(&path, boot_id).unwrap();
        assert_eq!(read_prior_boot_id(&path).unwrap(), Some(boot_id));
        assert_eq!(
            fs::symlink_metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn boot_id_rejects_malformed_duplicate_symlink_and_unsafe_modes() {
        let root = std::env::temp_dir().join(format!("firecrawl-boot-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("adapter.boot-id");
        for value in [
            "not-a-uuid\n".to_owned(),
            Uuid::new_v4().to_string(),
            format!("{}\n{}\n", Uuid::new_v4(), Uuid::new_v4()),
            format!("{}\n", Uuid::nil()),
        ] {
            fs::write(&path, value).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(read_prior_boot_id(&path).is_err());
        }
        fs::write(&path, format!("{}\n", Uuid::new_v4())).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_prior_boot_id(&path).is_err());
        fs::remove_file(&path).unwrap();
        let target = root.join("target");
        fs::write(&target, format!("{}\n", Uuid::new_v4())).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &path).unwrap();
        assert!(read_prior_boot_id(&path).is_err());
        fs::remove_file(&path).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(publish_boot_id(&path, Uuid::new_v4()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
