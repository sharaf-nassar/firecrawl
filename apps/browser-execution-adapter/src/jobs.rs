use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

use crate::action_client::{ActionClient, AdapterAuthorizationBinding};
use crate::app_server::{AppServer, PromptJob, ProtocolBundle};
use crate::broker_client::{
    BROKER_CONTRACT_SHA256, BrokerCancelReason, BrokerClient, BrokerDiagnostic, BrokerPhase,
    BrokerRuncState, BrokerTerminalOutcome, CodeBundle, PreparedCodex, PreparedLeaseMonitor,
};
use crate::code_relay::CodeRelay;
use crate::config::{AdapterConfig, effective_uid};
use crate::observations::ObservationV1;
use crate::protocol::{BrowserOperation, VersionOne, parse_json_strict};
use crate::redaction::{AdapterError, AdapterErrorCategory};

const MAX_TERMINAL_METADATA: usize = 4_096;
const TERMINAL_METADATA_RETENTION: Duration = Duration::from_secs(10 * 60);
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
    correlation_id: Option<Uuid>,
    lifecycle: JobLifecycle,
    state: JobState,
    cancel: watch::Sender<bool>,
    completion: watch::Sender<JobCompletion>,
    cancellation_requested: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalJob {
    pub run_id: Uuid,
    pub adapter_job_id: Uuid,
    pub correlation_id: Option<Uuid>,
    pub category: Option<AdapterErrorCategory>,
    pub lifecycle: LifecycleCounts,
}

#[derive(Clone, Copy, Debug)]
struct RetainedTerminalJob {
    job: TerminalJob,
    retained_at: Instant,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleCounts {
    pub payload_started_count: u32,
    pub callback_count: u32,
    pub browser_effect_count: u32,
}

#[derive(Clone, Debug, Default)]
pub struct JobLifecycle {
    payload_started_count: Arc<AtomicU32>,
    callback_count: Arc<AtomicU32>,
    browser_effect_count: Arc<AtomicU32>,
}

impl JobLifecycle {
    fn increment(counter: &AtomicU32) {
        let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
            Some(value.saturating_add(1))
        });
    }

    pub fn record_payload_started(&self) {
        Self::increment(&self.payload_started_count);
    }

    pub fn record_callback(&self) {
        Self::increment(&self.callback_count);
    }

    pub fn record_browser_effect(&self) {
        Self::increment(&self.browser_effect_count);
    }

    pub fn snapshot(&self) -> LifecycleCounts {
        LifecycleCounts {
            payload_started_count: self.payload_started_count.load(Ordering::Acquire),
            callback_count: self.callback_count.load(Ordering::Acquire),
            browser_effect_count: self.browser_effect_count.load(Ordering::Acquire),
        }
    }
}

#[derive(Debug, Default)]
struct RegistryState {
    active_by_run: BTreeMap<Uuid, JobEntry>,
    run_by_job: BTreeMap<Uuid, Uuid>,
    terminal: VecDeque<RetainedTerminalJob>,
    unproven_terminal: VecDeque<RetainedTerminalJob>,
}

#[derive(Clone, Debug)]
pub struct JobRegistry {
    inner: Arc<Mutex<RegistryState>>,
    max_prompt_runs: usize,
    max_code_runs: usize,
    terminal_retention: Duration,
}

#[derive(Debug)]
pub struct AdmittedJob {
    pub binding: AdapterAuthorizationBinding,
    pub cancellation: watch::Receiver<bool>,
    pub completion: watch::Receiver<JobCompletion>,
}

#[derive(Debug)]
pub struct ReservedJob {
    pub cancellation: watch::Receiver<bool>,
    pub completion: watch::Receiver<JobCompletion>,
    pub lifecycle: JobLifecycle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobCompletion {
    Pending,
    Proven,
    CleanupUnproven,
}

struct RegistryCompletionGuard {
    registry: JobRegistry,
    run_id: Uuid,
    adapter_job_id: Uuid,
    execution_healthy: Arc<AtomicBool>,
}

impl Drop for RegistryCompletionGuard {
    fn drop(&mut self) {
        if self
            .registry
            .fail_cleanup_reserved(self.run_id, self.adapter_job_id)
        {
            self.execution_healthy.store(false, Ordering::Release);
        }
    }
}

impl JobRegistry {
    pub fn new(max_prompt_runs: usize, max_code_runs: usize) -> Result<Self, AdapterError> {
        Self::new_with_terminal_retention(
            max_prompt_runs,
            max_code_runs,
            TERMINAL_METADATA_RETENTION,
        )
    }

    #[doc(hidden)]
    pub fn new_with_terminal_retention(
        max_prompt_runs: usize,
        max_code_runs: usize,
        terminal_retention: Duration,
    ) -> Result<Self, AdapterError> {
        if max_prompt_runs != 1 || max_code_runs != 2 {
            return Err(AdapterError::model_protocol());
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(RegistryState::default())),
            max_prompt_runs,
            max_code_runs,
            terminal_retention,
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
        self.reserve_internal(run_id, kind, adapter_job_id, adapter_supervisor_id, None)
    }

    pub fn reserve_correlated(
        &self,
        run_id: Uuid,
        kind: JobKind,
        adapter_job_id: Uuid,
        adapter_supervisor_id: Uuid,
        correlation_id: Uuid,
    ) -> Result<ReservedJob, AdapterError> {
        if correlation_id.is_nil() {
            return Err(AdapterError::model_protocol());
        }
        self.reserve_internal(
            run_id,
            kind,
            adapter_job_id,
            adapter_supervisor_id,
            Some(correlation_id),
        )
    }

    fn reserve_internal(
        &self,
        run_id: Uuid,
        kind: JobKind,
        adapter_job_id: Uuid,
        adapter_supervisor_id: Uuid,
        correlation_id: Option<Uuid>,
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
        let (completion_sender, completion) = watch::channel(JobCompletion::Pending);
        let lifecycle = JobLifecycle::default();
        registry.run_by_job.insert(adapter_job_id, run_id);
        registry.active_by_run.insert(
            run_id,
            JobEntry {
                adapter_job_id,
                adapter_supervisor_id,
                binding: None,
                kind,
                correlation_id,
                lifecycle: lifecycle.clone(),
                state: JobState::Preparing,
                cancel,
                completion: completion_sender,
                cancellation_requested: false,
            },
        );
        Ok(ReservedJob {
            cancellation,
            completion,
            lifecycle,
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

    pub fn request_cancel(
        &self,
        run_id: Uuid,
    ) -> Result<watch::Receiver<JobCompletion>, AdapterError> {
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
        if entry.kind != JobKind::Prompt {
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
        if entry.adapter_job_id != adapter_job_id || entry.kind != JobKind::Prompt {
            return false;
        }
        complete_entry(&mut registry, run_id, category)
    }

    fn complete_code(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
        category: Option<AdapterErrorCategory>,
    ) -> bool {
        self.prove_code_cleanup(run_id, binding) && self.finish_code(run_id, binding, category)
    }

    fn prove_code_cleanup(&self, run_id: Uuid, binding: AdapterAuthorizationBinding) -> bool {
        let Ok(mut registry) = self.inner.lock() else {
            return false;
        };
        let Some(entry) = registry.active_by_run.get_mut(&run_id) else {
            return false;
        };
        if entry.binding != Some(binding) || entry.kind != JobKind::Code {
            return false;
        }
        entry.completion.send_replace(JobCompletion::Proven);
        true
    }

    fn finish_code(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
        category: Option<AdapterErrorCategory>,
    ) -> bool {
        let Ok(mut registry) = self.inner.lock() else {
            return false;
        };
        let Some(entry) = registry.active_by_run.get(&run_id) else {
            return false;
        };
        if entry.binding != Some(binding)
            || entry.kind != JobKind::Code
            || *entry.completion.borrow() != JobCompletion::Proven
        {
            return false;
        }
        finish_entry(&mut registry, run_id, category)
    }

    fn complete_code_reserved(
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
        entry.completion.send_replace(JobCompletion::Proven);
        finish_entry(&mut registry, run_id, category)
    }

    fn fail_cleanup_reserved(&self, run_id: Uuid, adapter_job_id: Uuid) -> bool {
        let Ok(mut registry) = self.inner.lock() else {
            return false;
        };
        let Some(entry) = registry.active_by_run.get(&run_id) else {
            return false;
        };
        if entry.adapter_job_id != adapter_job_id {
            return false;
        }
        if *entry.completion.borrow() == JobCompletion::Proven {
            finish_entry(
                &mut registry,
                run_id,
                Some(AdapterErrorCategory::SandboxUnavailable),
            );
            return false;
        }
        let Some(entry) = registry.active_by_run.remove(&run_id) else {
            return false;
        };
        entry
            .completion
            .send_replace(JobCompletion::CleanupUnproven);
        registry.run_by_job.remove(&entry.adapter_job_id);
        prune_terminal_metadata(&mut registry, self.terminal_retention);
        registry.unproven_terminal.push_back(RetainedTerminalJob {
            job: TerminalJob {
                run_id,
                adapter_job_id: entry.adapter_job_id,
                correlation_id: entry.correlation_id,
                category: Some(AdapterErrorCategory::SandboxUnavailable),
                lifecycle: entry.lifecycle.snapshot(),
            },
            retained_at: Instant::now(),
        });
        while registry.unproven_terminal.len() > MAX_TERMINAL_METADATA {
            registry.unproven_terminal.pop_front();
        }
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
            .map(|mut registry| {
                prune_terminal_metadata(&mut registry, self.terminal_retention);
                registry.terminal.iter().map(|entry| entry.job).collect()
            })
            .unwrap_or_default()
    }

    pub fn lifecycle_counts(
        &self,
        correlation_id: Uuid,
        adapter_job_id: Uuid,
    ) -> Option<LifecycleCounts> {
        if correlation_id.is_nil() || adapter_job_id.is_nil() {
            return None;
        }
        let mut registry = self.inner.lock().ok()?;
        prune_terminal_metadata(&mut registry, self.terminal_retention);
        if let Some(entry) = registry.active_by_run.values().find(|entry| {
            entry.adapter_job_id == adapter_job_id && entry.correlation_id == Some(correlation_id)
        }) {
            return Some(entry.lifecycle.snapshot());
        }
        registry
            .terminal
            .iter()
            .rev()
            .chain(registry.unproven_terminal.iter().rev())
            .find(|entry| {
                entry.job.adapter_job_id == adapter_job_id
                    && entry.job.correlation_id == Some(correlation_id)
            })
            .map(|entry| entry.job.lifecycle)
    }
}

fn complete_entry(
    registry: &mut RegistryState,
    run_id: Uuid,
    category: Option<AdapterErrorCategory>,
) -> bool {
    let Some(entry) = registry.active_by_run.remove(&run_id) else {
        return false;
    };
    entry.completion.send_replace(JobCompletion::Proven);
    registry.active_by_run.insert(run_id, entry);
    finish_entry(registry, run_id, category)
}

fn finish_entry(
    registry: &mut RegistryState,
    run_id: Uuid,
    category: Option<AdapterErrorCategory>,
) -> bool {
    let Some(entry) = registry.active_by_run.remove(&run_id) else {
        return false;
    };
    registry.run_by_job.remove(&entry.adapter_job_id);
    push_terminal(
        registry,
        TerminalJob {
            run_id,
            adapter_job_id: entry.adapter_job_id,
            correlation_id: entry.correlation_id,
            category,
            lifecycle: entry.lifecycle.snapshot(),
        },
    );
    true
}

fn push_terminal(registry: &mut RegistryState, terminal: TerminalJob) {
    registry.terminal.push_back(RetainedTerminalJob {
        job: terminal,
        retained_at: Instant::now(),
    });
    while registry.terminal.len() > MAX_TERMINAL_METADATA {
        registry.terminal.pop_front();
    }
}

fn prune_terminal_metadata(registry: &mut RegistryState, retention: Duration) {
    let now = Instant::now();
    for terminal in [&mut registry.terminal, &mut registry.unproven_terminal] {
        while terminal
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.retained_at) >= retention)
        {
            terminal.pop_front();
        }
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

impl CodeRequestBody {
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
            || self.source.len() > 100_000
            || self.deadline.is_empty()
        {
            return Err(AdapterError::model_protocol());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CodeLanguage {
    Node,
    Python,
    Bash,
}

impl CodeLanguage {
    const fn bundle(self) -> CodeBundle {
        match self {
            Self::Node => CodeBundle::Node,
            Self::Python => CodeBundle::Python,
            Self::Bash => CodeBundle::Bash,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CodeResultBody {
    stdout: String,
    result: String,
    stderr: String,
    exit_code: u8,
    killed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelRequestBody {
    pub run_id: Uuid,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthRequestBody {}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusRequestBody {}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiagnoseHostJobRequestBody {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub correlation_id: Uuid,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub job_id: Uuid,
}

fn deserialize_canonical_uuid<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    let uuid = Uuid::parse_str(&raw).map_err(serde::de::Error::custom)?;
    if uuid.is_nil() || uuid.to_string() != raw {
        return Err(serde::de::Error::custom(
            "UUID must be canonical and non-nil",
        ));
    }
    Ok(uuid)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum AdapterRequest {
    ExecutePrompt {
        version: VersionOne,
        #[serde(rename = "requestId", deserialize_with = "deserialize_canonical_uuid")]
        request_id: Uuid,
        body: Box<PromptRequestBody>,
    },
    ExecuteCode {
        version: VersionOne,
        #[serde(rename = "requestId", deserialize_with = "deserialize_canonical_uuid")]
        request_id: Uuid,
        body: CodeRequestBody,
    },
    Cancel {
        version: VersionOne,
        #[serde(rename = "requestId", deserialize_with = "deserialize_canonical_uuid")]
        request_id: Uuid,
        body: CancelRequestBody,
    },
    Health {
        version: VersionOne,
        #[serde(rename = "requestId", deserialize_with = "deserialize_canonical_uuid")]
        request_id: Uuid,
        body: HealthRequestBody,
    },
    Status {
        version: VersionOne,
        #[serde(rename = "requestId", deserialize_with = "deserialize_canonical_uuid")]
        request_id: Uuid,
        body: StatusRequestBody,
    },
    DiagnoseHostJob {
        version: VersionOne,
        #[serde(rename = "requestId", deserialize_with = "deserialize_canonical_uuid")]
        request_id: Uuid,
        body: DiagnoseHostJobRequestBody,
    },
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HealthResultBody {
    version: VersionOne,
    status: &'static str,
    codex_cli_version: String,
    codex_artifact_sha256: String,
    codex_protocol_schema_sha256: String,
    broker_protocol_sha256: &'static str,
    model: &'static str,
    reasoning_effort: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StatusResultBody {
    version: VersionOne,
    prepared_host_jobs: u32,
    starting_host_jobs: u32,
    running_host_jobs: u32,
    unsettled_host_jobs: u32,
    orphan_processes: u32,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnoseHostJobResultBody {
    version: VersionOne,
    correlation_id: Uuid,
    job_id: Uuid,
    phase: BrokerPhase,
    host_init_pid: Option<u32>,
    pidfd_live: bool,
    pidfd_pid_matches: bool,
    control_lease_connected: bool,
    inert_relay_fd_present: bool,
    relay_listener_present: bool,
    cdp_relay_opened: bool,
    payload_started_count: u32,
    payload_marker_present: bool,
    callback_count: u32,
    browser_effect_count: u32,
    runc_state: Option<BrokerRuncState>,
    cgroup_present: bool,
    job_directory_present: bool,
    child_count: u32,
    cleanup_failure: bool,
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
    prompt_execution_healthy: Arc<AtomicBool>,
    code_execution_healthy: Arc<AtomicBool>,
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
            prompt_execution_healthy: Arc::new(AtomicBool::new(true)),
            code_execution_healthy: Arc::new(AtomicBool::new(true)),
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
            prompt_execution_healthy: Arc::new(AtomicBool::new(true)),
            code_execution_healthy: Arc::new(AtomicBool::new(true)),
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
        let request_id = match &request {
            AdapterRequest::ExecutePrompt { request_id, .. }
            | AdapterRequest::ExecuteCode { request_id, .. }
            | AdapterRequest::Cancel { request_id, .. }
            | AdapterRequest::Health { request_id, .. }
            | AdapterRequest::Status { request_id, .. }
            | AdapterRequest::DiagnoseHostJob { request_id, .. } => *request_id,
        };
        let result = match request {
            AdapterRequest::ExecutePrompt {
                request_id, body, ..
            } => {
                self.execute_prompt(request_id, *body, &mut reader, &mut writer)
                    .await
            }
            AdapterRequest::ExecuteCode {
                request_id, body, ..
            } => {
                self.execute_code(request_id, body, &mut reader, &mut writer)
                    .await
            }
            AdapterRequest::Cancel {
                request_id, body, ..
            } => self.cancel(request_id, body, &mut writer).await,
            AdapterRequest::Health { request_id, .. } => self.health(request_id, &mut writer).await,
            AdapterRequest::Status { request_id, .. } => self.status(request_id, &mut writer).await,
            AdapterRequest::DiagnoseHostJob {
                request_id, body, ..
            } => self.diagnose_host_job(request_id, body, &mut writer).await,
        };
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                write_response(
                    &mut writer,
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

    async fn execute_prompt(
        &self,
        request_id: Uuid,
        body: PromptRequestBody,
        reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        body.validate()?;
        let (deadline_unix_ms, deadline) = parse_deadline(&body.deadline)?;
        if !self.prompt_execution_healthy.load(Ordering::Acquire) {
            return Err(AdapterError::codex_unavailable());
        }
        let reserved = self.registry.reserve_correlated(
            body.run_id,
            JobKind::Prompt,
            body.adapter_job_id,
            body.adapter_supervisor_id,
            body.correlation_id,
        )?;
        let lifecycle = reserved.lifecycle.clone();
        let mut cancellation = reserved.cancellation;
        let _completion_guard = RegistryCompletionGuard {
            registry: self.registry.clone(),
            run_id: body.run_id,
            adapter_job_id: body.adapter_job_id,
            execution_healthy: self.prompt_execution_healthy.clone(),
        };
        let broker = self.broker.clone();
        let job_id = body.adapter_job_id;
        let adapter_boot_id = self.boot_id.ok_or_else(AdapterError::sandbox_unavailable)?;
        let auth_file = self.config.codex_auth_file.clone();
        let correlation_id = body.correlation_id;
        let (prepare_control, prepare_interrupter) = self.broker.prepare_control()?;
        let mut prepare_task = tokio::task::spawn_blocking(move || {
            broker.prepare_codex_on(
                prepare_control,
                job_id,
                adapter_boot_id,
                correlation_id,
                deadline_unix_ms,
                &auth_file,
            )
        });
        let mut interrupted = None;
        let completed_prepare = tokio::select! {
            result = &mut prepare_task => Some(result),
            _ = tokio::time::sleep_until(deadline) => {
                interrupted = Some(AdapterError::timed_out());
                None
            }
            changed = cancellation.changed() => {
                interrupted = Some(match changed {
                    Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                    _ => AdapterError::model_protocol(),
                });
                None
            }
        };
        let prepared_result = match completed_prepare {
            Some(result) => {
                drop(prepare_interrupter);
                result
                    .map_err(|_| AdapterError::codex_unavailable())
                    .and_then(|result| result)
            }
            None => {
                let error = interrupted.ok_or_else(AdapterError::sandbox_unavailable)?;
                let _ = prepare_interrupter.interrupt();
                prepare_task.abort();
                drop(prepare_task);
                let reason = if error.category == AdapterErrorCategory::TimedOut {
                    BrokerCancelReason::TimedOut
                } else if error.category == AdapterErrorCategory::Cancelled {
                    BrokerCancelReason::Cancelled
                } else {
                    BrokerCancelReason::ProtocolError
                };
                self.confirm_ambiguous_prepare_cleanup(
                    body.adapter_job_id,
                    adapter_boot_id,
                    reason,
                )
                .await?;
                if !self.registry.complete_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    Some(error.category),
                ) {
                    return Err(AdapterError::codex_unavailable());
                }
                return Err(error);
            }
        };
        let mut prepared = match prepared_result {
            Ok(prepared) => prepared,
            Err(error) => {
                self.confirm_ambiguous_prepare_cleanup(
                    body.adapter_job_id,
                    adapter_boot_id,
                    BrokerCancelReason::ProtocolError,
                )
                .await?;
                if !self.registry.complete_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    Some(error.category),
                ) {
                    return Err(AdapterError::codex_unavailable());
                }
                return Err(error);
            }
        };
        let binding = match AdapterAuthorizationBinding::new(
            body.adapter_job_id,
            body.adapter_supervisor_id,
            prepared.init_pid,
        ) {
            Ok(binding) => binding,
            Err(error) => {
                self.abort_prompt_and_complete_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await?;
                return Err(error);
            }
        };
        if let Err(error) = self.registry.bind_prepared(body.run_id, binding) {
            self.abort_prompt_and_complete_reserved(
                body.run_id,
                body.adapter_job_id,
                &mut prepared,
                BrokerCancelReason::ProtocolError,
                Some(error.category),
            )
            .await?;
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
            .await?;
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
                .await?;
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
                .await?;
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
                .await?;
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
            lifecycle.clone(),
        );
        let stderr = AuditedReader::new(
            stderr,
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
            payload_started,
            lifecycle.clone(),
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
                .await?;
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
            .await?;
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
                .await?;
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
                .await?;
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
            .await?;
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
            .await?;
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
            .await?;
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
            .await?;
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
                .await?;
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
                let (returned, result) = match result {
                    Ok(result) => result,
                    Err(_) => {
                        let error = AdapterError::sandbox_unavailable();
                        self.confirm_ambiguous_start_cleanup(
                            body.adapter_job_id,
                            binding.adapter_process_id,
                            adapter_boot_id,
                            BrokerCancelReason::ProtocolError,
                        )
                        .await?;
                        if !self
                            .registry
                            .complete(body.run_id, binding, Some(error.category))
                        {
                            return Err(AdapterError::codex_unavailable());
                        }
                        return Err(error);
                    }
                };
                prepared = returned;
                if let Err(error) = result {
                    prepared.control.take();
                    self.confirm_ambiguous_start_cleanup(
                        body.adapter_job_id,
                        binding.adapter_process_id,
                        adapter_boot_id,
                        BrokerCancelReason::ProtocolError,
                    )
                    .await?;
                    if !self
                        .registry
                        .complete(body.run_id, binding, Some(error.category))
                    {
                        return Err(AdapterError::codex_unavailable());
                    }
                    return Err(error);
                }
            }
            StartWait::Interrupted(error) => {
                let _ = start_interrupter.interrupt();
                if let Ok((mut returned, _)) = start_task.await {
                    returned.control.take();
                }
                let reason = if error.category == AdapterErrorCategory::TimedOut {
                    BrokerCancelReason::TimedOut
                } else if error.category == AdapterErrorCategory::Cancelled {
                    BrokerCancelReason::Cancelled
                } else {
                    BrokerCancelReason::ProtocolError
                };
                self.confirm_ambiguous_start_cleanup(
                    body.adapter_job_id,
                    binding.adapter_process_id,
                    adapter_boot_id,
                    reason,
                )
                .await?;
                if !self
                    .registry
                    .complete(body.run_id, binding, Some(error.category))
                {
                    return Err(AdapterError::codex_unavailable());
                }
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
                            lifecycle.record_callback();
                            let browser_effect = operation_has_browser_effect(&operation);
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            let lifecycle = lifecycle.clone();
                            let pending = action_client.execute(sequence, operation, remaining);
                            async move {
                                let result = pending.await;
                                if result.is_ok() && browser_effect {
                                    lifecycle.record_browser_effect();
                                }
                                result
                            }
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
        let terminal = cleanup?;
        let terminal_outcome = terminal.outcome;
        let _artifacts = terminal.artifacts;
        run_result = apply_broker_terminal_outcome(run_result, terminal_outcome);
        if terminal_outcome == BrokerTerminalOutcome::Completed
            && let Err(error) = app_server
                .verify_terminated_stdout(Instant::now() + MAX_AUTHORIZATION_WAIT)
                .await
            && run_result.is_ok()
        {
            run_result = Err(error);
        }
        let category = run_result.as_ref().err().map(|error| error.category);
        if !self.registry.complete(body.run_id, binding, category) {
            return Err(AdapterError::codex_unavailable());
        }
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

    async fn execute_code(
        &self,
        request_id: Uuid,
        body: CodeRequestBody,
        reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        body.validate()?;
        let (deadline_unix_ms, deadline) = parse_deadline(&body.deadline)?;
        if !self.code_execution_healthy.load(Ordering::Acquire) {
            return Err(AdapterError::sandbox_unavailable());
        }
        let reserved = self.registry.reserve_correlated(
            body.run_id,
            JobKind::Code,
            body.adapter_job_id,
            body.adapter_supervisor_id,
            body.correlation_id,
        )?;
        let lifecycle = reserved.lifecycle.clone();
        let mut cancellation = reserved.cancellation;
        let _completion_guard = RegistryCompletionGuard {
            registry: self.registry.clone(),
            run_id: body.run_id,
            adapter_job_id: body.adapter_job_id,
            execution_healthy: self.code_execution_healthy.clone(),
        };
        let broker = self.broker.clone();
        let adapter_boot_id = self.boot_id.ok_or_else(AdapterError::sandbox_unavailable)?;
        let job_id = body.adapter_job_id;
        let correlation_id = body.correlation_id;
        let bundle = body.language.bundle();
        let source = body.source.into_bytes();
        let (prepare_control, prepare_interrupter) = self.broker.prepare_control()?;
        let mut prepare_task = tokio::task::spawn_blocking(move || {
            broker.prepare_code_on(
                prepare_control,
                job_id,
                adapter_boot_id,
                correlation_id,
                deadline_unix_ms,
                bundle,
                &source,
            )
        });
        let mut interrupted = None;
        let completed_prepare = tokio::select! {
            result = &mut prepare_task => Some(result),
            _ = tokio::time::sleep_until(deadline) => {
                interrupted = Some(AdapterError::timed_out());
                None
            }
            changed = cancellation.changed() => {
                interrupted = Some(match changed {
                    Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                    _ => AdapterError::model_protocol(),
                });
                None
            }
        };
        let prepared_result = match completed_prepare {
            Some(result) => {
                drop(prepare_interrupter);
                result
                    .map_err(|_| AdapterError::sandbox_unavailable())
                    .and_then(|result| result)
            }
            None => {
                let error = interrupted.ok_or_else(AdapterError::sandbox_unavailable)?;
                let _ = prepare_interrupter.interrupt();
                prepare_task.abort();
                drop(prepare_task);
                let reason = if error.category == AdapterErrorCategory::TimedOut {
                    BrokerCancelReason::TimedOut
                } else if error.category == AdapterErrorCategory::Cancelled {
                    BrokerCancelReason::Cancelled
                } else {
                    BrokerCancelReason::ProtocolError
                };
                self.confirm_ambiguous_prepare_cleanup(
                    body.adapter_job_id,
                    adapter_boot_id,
                    reason,
                )
                .await?;
                if !self.registry.complete_code_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    Some(error.category),
                ) {
                    return Err(AdapterError::sandbox_unavailable());
                }
                return Err(error);
            }
        };
        let mut prepared = match prepared_result {
            Ok(prepared) => prepared,
            Err(error) => {
                self.confirm_ambiguous_prepare_cleanup(
                    body.adapter_job_id,
                    adapter_boot_id,
                    BrokerCancelReason::ProtocolError,
                )
                .await?;
                if !self.registry.complete_code_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    Some(error.category),
                ) {
                    return Err(AdapterError::sandbox_unavailable());
                }
                return Err(error);
            }
        };
        let binding = match AdapterAuthorizationBinding::new(
            body.adapter_job_id,
            body.adapter_supervisor_id,
            prepared.init_pid,
        ) {
            Ok(binding) => binding,
            Err(error) => {
                self.abort_code_and_complete_reserved(
                    body.run_id,
                    body.adapter_job_id,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await?;
                return Err(error);
            }
        };
        if let Err(error) = self.registry.bind_prepared(body.run_id, binding) {
            self.abort_code_and_complete_reserved(
                body.run_id,
                body.adapter_job_id,
                &mut prepared,
                BrokerCancelReason::ProtocolError,
                Some(error.category),
            )
            .await?;
            return Err(error);
        }
        let callback_token = match self.config.read_callback_token() {
            Ok(token) => token,
            Err(error) => {
                self.abort_code_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await?;
                return Err(error);
            }
        };
        let action_client = match ActionClient::new(
            self.config.callback_url.clone(),
            callback_token.clone(),
            binding,
            body.run_id,
        ) {
            Ok(client) => client,
            Err(error) => {
                self.abort_code_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await?;
                return Err(error);
            }
        };
        let (stdout, stderr, relay_fd) = match (
            prepared.stdout.take(),
            prepared.stderr.take(),
            prepared.relay.take(),
            prepared.stdin.take(),
        ) {
            (Some(stdout), Some(stderr), Some(relay), None) => (stdout, stderr, relay),
            _ => {
                self.abort_code_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(AdapterErrorCategory::SandboxUnavailable),
                )
                .await?;
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
            lifecycle.clone(),
        );
        let stderr = AuditedReader::new(
            stderr,
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
            payload_started,
            lifecycle.clone(),
        );
        let lease_monitor = match self.broker.monitor_prepared(&prepared) {
            Ok(monitor) => monitor,
            Err(error) => {
                self.abort_code_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::ProtocolError,
                    Some(error.category),
                )
                .await?;
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
            self.abort_code_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::AuthorizationFailed,
                Some(AdapterErrorCategory::Cancelled),
            )
            .await?;
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
        match acknowledgement {
            Ok(acknowledgement)
                if acknowledgement.request_id == request_id
                    && AdapterAuthorizationBinding::try_from(acknowledgement.binding)
                        .is_ok_and(|acknowledged| acknowledged == binding) => {}
            Ok(_) => {
                self.abort_code_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::AuthorizationFailed,
                    Some(AdapterErrorCategory::ModelProtocolError),
                )
                .await?;
                return Err(AdapterError::model_protocol());
            }
            Err(error) => {
                self.abort_code_and_complete(
                    body.run_id,
                    binding,
                    &mut prepared,
                    BrokerCancelReason::AuthorizationFailed,
                    Some(error.category),
                )
                .await?;
                return Err(error);
            }
        }
        if let Err(error) = self.broker.ensure_prepared_lease_quiet(&prepared) {
            self.abort_code_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::ProtocolError,
                Some(error.category),
            )
            .await?;
            return Err(error);
        }
        if let Err(error) = self.registry.authorize(body.run_id, binding) {
            self.abort_code_and_complete(
                body.run_id,
                binding,
                &mut prepared,
                BrokerCancelReason::ProtocolError,
                Some(error.category),
            )
            .await?;
            return Err(error);
        }
        let relay_connect = CodeRelay::connect_with_lifecycle(
            self.config.callback_url.clone(),
            callback_token,
            binding,
            body.run_id,
            relay_fd,
            deadline,
            lifecycle,
        );
        tokio::pin!(relay_connect);
        let relay_result = tokio::select! {
            result = &mut relay_connect => result,
            _ = tokio::time::sleep_until(deadline) => Err(AdapterError::timed_out()),
            changed = cancellation.changed() => {
                Err(match changed {
                    Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                    _ => AdapterError::model_protocol(),
                })
            }
        };
        let mut relay = match relay_result {
            Ok(relay) => relay,
            Err(error) => {
                let reason = if error.category == AdapterErrorCategory::TimedOut {
                    BrokerCancelReason::TimedOut
                } else if error.category == AdapterErrorCategory::Cancelled {
                    BrokerCancelReason::Cancelled
                } else {
                    BrokerCancelReason::AuthorizationFailed
                };
                self.cancel_prepared_confirmed(&mut prepared, reason)
                    .await?;
                return Err(AdapterError::sandbox_unavailable());
            }
        };
        emit_lifecycle(
            "api_authorized",
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
        );
        if let Err(error) = self.registry.begin_start(body.run_id, binding) {
            relay.stop_bundle_traffic();
            let cleanup = self
                .cancel_prepared_confirmed(&mut prepared, BrokerCancelReason::Cancelled)
                .await;
            let release = relay.close_and_confirm().await;
            cleanup?;
            release?;
            if !self
                .registry
                .complete_code(body.run_id, binding, Some(error.category))
            {
                return Err(AdapterError::sandbox_unavailable());
            }
            return Err(error);
        }
        let start_interrupter = match self.broker.start_interrupter(&prepared) {
            Ok(interrupter) => interrupter,
            Err(error) => {
                relay.stop_bundle_traffic();
                let cleanup = self
                    .cancel_prepared_confirmed(&mut prepared, BrokerCancelReason::ProtocolError)
                    .await;
                let release = relay.close_and_confirm().await;
                cleanup?;
                release?;
                if !self
                    .registry
                    .complete_code(body.run_id, binding, Some(error.category))
                {
                    return Err(AdapterError::sandbox_unavailable());
                }
                return Err(error);
            }
        };
        let broker = self.broker.clone();
        let mut start_task = tokio::task::spawn_blocking(move || {
            let mut prepared = prepared;
            let result = broker.start(&mut prepared);
            (prepared, result)
        });
        let mut interrupted = None;
        let completed_start = tokio::select! {
            result = &mut start_task => Some(result),
            _ = tokio::time::sleep_until(deadline) => {
                interrupted = Some(AdapterError::timed_out());
                None
            },
            changed = cancellation.changed() => {
                interrupted = Some(match changed {
                    Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                    _ => AdapterError::model_protocol(),
                });
                None
            }
        };
        let (returned, started) = match completed_start {
            Some(Ok(result)) => {
                drop(start_interrupter);
                result
            }
            Some(Err(_)) => {
                drop(start_interrupter);
                let error = AdapterError::sandbox_unavailable();
                relay.stop_bundle_traffic();
                let cleanup = self
                    .confirm_ambiguous_start_cleanup(
                        body.adapter_job_id,
                        binding.adapter_process_id,
                        adapter_boot_id,
                        BrokerCancelReason::ProtocolError,
                    )
                    .await;
                let release = relay.close_and_confirm().await;
                cleanup?;
                release?;
                if !self
                    .registry
                    .complete_code(body.run_id, binding, Some(error.category))
                {
                    return Err(AdapterError::sandbox_unavailable());
                }
                return Err(error);
            }
            None => {
                let error = interrupted.ok_or_else(AdapterError::sandbox_unavailable)?;
                relay.stop_bundle_traffic();
                let _ = start_interrupter.interrupt();
                if let Ok((mut returned, _)) = start_task.await {
                    returned.control.take();
                }
                let reason = if error.category == AdapterErrorCategory::TimedOut {
                    BrokerCancelReason::TimedOut
                } else if error.category == AdapterErrorCategory::Cancelled {
                    BrokerCancelReason::Cancelled
                } else {
                    BrokerCancelReason::ProtocolError
                };
                let cleanup = self
                    .confirm_ambiguous_start_cleanup(
                        body.adapter_job_id,
                        binding.adapter_process_id,
                        adapter_boot_id,
                        reason,
                    )
                    .await;
                let release = relay.close_and_confirm().await;
                cleanup?;
                release?;
                if !self
                    .registry
                    .complete_code(body.run_id, binding, Some(error.category))
                {
                    return Err(AdapterError::sandbox_unavailable());
                }
                return Err(error);
            }
        };
        prepared = returned;
        if let Err(error) = started {
            relay.stop_bundle_traffic();
            prepared.control.take();
            let cleanup = self
                .confirm_ambiguous_start_cleanup(
                    body.adapter_job_id,
                    binding.adapter_process_id,
                    adapter_boot_id,
                    BrokerCancelReason::ProtocolError,
                )
                .await;
            let release = relay.close_and_confirm().await;
            cleanup?;
            release?;
            if !self
                .registry
                .complete_code(body.run_id, binding, Some(error.category))
            {
                return Err(AdapterError::sandbox_unavailable());
            }
            return Err(error);
        }
        emit_lifecycle(
            "broker_started",
            body.correlation_id,
            body.adapter_job_id,
            prepared.init_pid,
        );
        let mut stdout_task = tokio::spawn(read_code_output(stdout));
        let mut stderr_task = tokio::spawn(read_code_output(stderr));
        let relay_run = if let Err(error) = self.registry.mark_running(body.run_id, binding) {
            crate::code_relay::CodeRelayRun {
                relay,
                result: Err(error),
            }
        } else {
            relay.run(deadline, cancellation.clone()).await
        };
        let run_result = match relay_run.result {
            Ok(()) => {
                tokio::select! {
                    joined = async { tokio::try_join!(&mut stdout_task, &mut stderr_task) } => {
                        match joined {
                            Ok((Ok(stdout), Ok(stderr))) => Ok((stdout, stderr)),
                            Ok((Err(error), _)) | Ok((_, Err(error))) => Err(error),
                            Err(_) => Err(AdapterError::sandbox_unavailable()),
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => Err(AdapterError::timed_out()),
                    changed = cancellation.changed() => {
                        Err(match changed {
                            Ok(()) if *cancellation.borrow() => AdapterError::cancelled(),
                            _ => AdapterError::model_protocol(),
                        })
                    }
                }
            }
            Err(error) => Err(error),
        };
        if run_result.is_err() {
            stdout_task.abort();
            stderr_task.abort();
        }
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
        let terminal = tokio::task::spawn_blocking(move || {
            broker.finish(&mut prepared, adapter_boot_id, reason)
        })
        .await
        .map_err(|_| AdapterError::sandbox_unavailable())
        .and_then(|result| result);
        let release = relay_run.relay.close_and_confirm().await;
        let terminal = terminal?;
        release?;
        if !self.registry.prove_code_cleanup(body.run_id, binding) {
            return Err(AdapterError::sandbox_unavailable());
        }
        let outcome = terminal.outcome;
        let result = match (run_result, outcome) {
            (Ok((stdout, stderr)), BrokerTerminalOutcome::Completed) => {
                let upload = action_client
                    .upload_artifacts(
                        &terminal.artifacts,
                        deadline.saturating_duration_since(Instant::now()),
                    )
                    .await;
                upload.map(|()| CodeResultBody {
                    stdout,
                    result: String::new(),
                    stderr,
                    exit_code: 0,
                    killed: false,
                })
            }
            (Err(error), _) => Err(error),
            _ => Err(AdapterError::sandbox_unavailable()),
        };
        let category = result.as_ref().err().map(|error| error.category);
        if !self.registry.finish_code(body.run_id, binding, category) {
            return Err(AdapterError::sandbox_unavailable());
        }
        match result {
            Ok(body) => {
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
        if *completion.borrow() == JobCompletion::Pending
            && !matches!(
                tokio::time::timeout(MAX_AUTHORIZATION_WAIT, completion.changed()).await,
                Ok(Ok(()))
            )
        {
            return write_response(
                writer,
                &AdapterResponse::<Value>::Error {
                    version: VersionOne,
                    request_id,
                    error: AdapterError::sandbox_unavailable(),
                },
            )
            .await;
        }
        if *completion.borrow() != JobCompletion::Proven {
            return write_response(
                writer,
                &AdapterResponse::<Value>::Error {
                    version: VersionOne,
                    request_id,
                    error: AdapterError::sandbox_unavailable(),
                },
            )
            .await;
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

    async fn health(
        &self,
        request_id: Uuid,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        let config = self.config.clone();
        let identity = tokio::task::spawn_blocking(move || {
            verify_adapter_socket(&config.adapter_socket)?;
            config.read_callback_token()?;
            let auth = crate::config::read_private_file(&config.codex_auth_file, 1024 * 1024)
                .map_err(|_| AdapterError::codex_unavailable())?;
            parse_json_strict::<Value>(&auth).map_err(|_| AdapterError::codex_unavailable())?;
            deterministic_protocol_self_check()?;
            verify_installed_health_identity(&config.protocol_root)
        })
        .await
        .map_err(|_| AdapterError::codex_unavailable())??;
        let broker = self.broker.clone();
        tokio::task::spawn_blocking(move || broker.health())
            .await
            .map_err(|_| AdapterError::sandbox_unavailable())??;
        write_response(
            writer,
            &AdapterResponse::Result {
                version: VersionOne,
                request_id,
                body: HealthResultBody {
                    version: VersionOne,
                    status: "ok",
                    codex_cli_version: identity.codex_cli_version,
                    codex_artifact_sha256: identity.codex_artifact_sha256,
                    codex_protocol_schema_sha256: identity.codex_protocol_schema_sha256,
                    broker_protocol_sha256: BROKER_CONTRACT_SHA256,
                    model: crate::app_server::MODEL,
                    reasoning_effort: crate::app_server::EFFORT,
                },
            },
        )
        .await
    }

    async fn status(
        &self,
        request_id: Uuid,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        let broker = self.broker.clone();
        let status = tokio::task::spawn_blocking(move || broker.status())
            .await
            .map_err(|_| AdapterError::sandbox_unavailable())??;
        write_response(
            writer,
            &AdapterResponse::Result {
                version: VersionOne,
                request_id,
                body: StatusResultBody {
                    version: VersionOne,
                    prepared_host_jobs: status.prepared_jobs,
                    starting_host_jobs: status.starting_jobs,
                    running_host_jobs: status.running_jobs,
                    unsettled_host_jobs: status.unsettled_jobs,
                    orphan_processes: status.orphan_processes,
                },
            },
        )
        .await
    }

    async fn diagnose_host_job(
        &self,
        request_id: Uuid,
        body: DiagnoseHostJobRequestBody,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) -> Result<(), AdapterError> {
        if body.correlation_id.is_nil() || body.job_id.is_nil() {
            return Err(AdapterError::model_protocol());
        }
        let broker = self.broker.clone();
        let correlation_id = body.correlation_id;
        let job_id = body.job_id;
        let diagnostic =
            tokio::task::spawn_blocking(move || broker.diagnose(correlation_id, job_id))
                .await
                .map_err(|_| AdapterError::sandbox_unavailable())??;
        let lifecycle = self
            .registry
            .lifecycle_counts(body.correlation_id, body.job_id)
            .ok_or_else(AdapterError::not_found)?;
        write_response(
            writer,
            &AdapterResponse::Result {
                version: VersionOne,
                request_id,
                body: diagnose_result(diagnostic, lifecycle),
            },
        )
        .await
    }

    async fn confirm_ambiguous_start_cleanup(
        &self,
        job_id: Uuid,
        init_pid: u32,
        adapter_boot_id: Uuid,
        reason: BrokerCancelReason,
    ) -> Result<(), AdapterError> {
        let broker = self.broker.clone();
        tokio::task::spawn_blocking(move || {
            broker.cancel_ambiguous_start(job_id, init_pid, adapter_boot_id, reason)
        })
        .await
        .map_err(|_| AdapterError::sandbox_unavailable())?
    }

    async fn confirm_ambiguous_prepare_cleanup(
        &self,
        job_id: Uuid,
        adapter_boot_id: Uuid,
        reason: BrokerCancelReason,
    ) -> Result<(), AdapterError> {
        let broker = self.broker.clone();
        tokio::task::spawn_blocking(move || {
            broker.cancel_ambiguous_prepare(job_id, adapter_boot_id, reason)
        })
        .await
        .map_err(|_| AdapterError::sandbox_unavailable())?
    }

    async fn cancel_prepared_confirmed(
        &self,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
    ) -> Result<(), AdapterError> {
        prepared.control.take();
        self.confirm_ambiguous_start_cleanup(
            prepared.job_id,
            prepared.init_pid,
            self.boot_id.ok_or_else(AdapterError::sandbox_unavailable)?,
            reason,
        )
        .await
    }

    async fn abort_code_and_complete_reserved(
        &self,
        run_id: Uuid,
        adapter_job_id: Uuid,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
        category: Option<AdapterErrorCategory>,
    ) -> Result<(), AdapterError> {
        self.cancel_prepared_confirmed(prepared, reason).await?;
        if !self
            .registry
            .complete_code_reserved(run_id, adapter_job_id, category)
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        Ok(())
    }

    async fn abort_prompt_and_complete_reserved(
        &self,
        run_id: Uuid,
        adapter_job_id: Uuid,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
        category: Option<AdapterErrorCategory>,
    ) -> Result<(), AdapterError> {
        self.cancel_prepared_confirmed(prepared, reason).await?;
        if !self
            .registry
            .complete_reserved(run_id, adapter_job_id, category)
        {
            return Err(AdapterError::codex_unavailable());
        }
        Ok(())
    }

    async fn abort_code_and_complete(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
        category: Option<AdapterErrorCategory>,
    ) -> Result<(), AdapterError> {
        self.cancel_prepared_confirmed(prepared, reason).await?;
        if !self.registry.complete_code(run_id, binding, category) {
            return Err(AdapterError::sandbox_unavailable());
        }
        Ok(())
    }

    async fn abort_and_complete(
        &self,
        run_id: Uuid,
        binding: AdapterAuthorizationBinding,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
        category: Option<AdapterErrorCategory>,
    ) -> Result<(), AdapterError> {
        self.cancel_prepared_confirmed(prepared, reason).await?;
        if !self.registry.complete(run_id, binding, category) {
            return Err(AdapterError::codex_unavailable());
        }
        Ok(())
    }
}

fn deterministic_protocol_self_check() -> Result<(), AdapterError> {
    use crate::decision::{
        Effect, classify, normalize_model_decision_envelope, parse_decision_envelope,
    };
    let first = parse_decision_envelope(
        r#"{"decision":{"type":"action","version":1,"action":{"kind":"snapshot"}}}"#,
    )
    .map(normalize_model_decision_envelope)
    .map_err(|_| AdapterError::model_protocol())?;
    let second = parse_decision_envelope(
        r#"{"decision":{"type":"final","version":1,"output":"health-ok"}}"#,
    )
    .map(normalize_model_decision_envelope)
    .map_err(|_| AdapterError::model_protocol())?;
    if classify(&first) != Effect::ReadOnly
        || !matches!(
            second,
            crate::protocol::ModelDecisionV1::Final { ref output, .. }
                if output == "health-ok"
        )
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(())
}

#[derive(Debug)]
struct InstalledHealthIdentity {
    codex_cli_version: String,
    codex_artifact_sha256: String,
    codex_protocol_schema_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstalledManifest {
    format_version: u8,
    build_timestamp: String,
    codex_app_server: InstalledCodexManifest,
    code_runtime: InstalledCodeRuntime,
    bundle_digests: BTreeMap<String, String>,
    policy_hashes: BTreeMap<String, String>,
    broker_contract_sha256: String,
    binary_hashes: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstalledCodexManifest {
    format_version: u8,
    source_identity: InstalledCodexIdentity,
    artifact_sha256: String,
    protocol_sha256: String,
    feature_sha256: String,
    gate_attestation_sha256: String,
    model: String,
    reasoning_effort: String,
    build_timestamp: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstalledCodexIdentity {
    executable_path: String,
    resolved_path: String,
    device: String,
    inode: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstalledCodeRuntime {
    node: String,
    python: String,
    bash: String,
    javascript_playwright: String,
    python_playwright: String,
    relay_protocol: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RootfsIdentity {
    version: u8,
    bundle_id: String,
    rootfs_sha256: String,
}

fn verify_adapter_socket(path: &Path) -> Result<(), AdapterError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AdapterError::sandbox_unavailable())?;
    if !metadata.file_type().is_socket()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o777 != 0o600
        || metadata.uid() != effective_uid()?
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    Ok(())
}

fn verify_installed_health_identity(
    protocol_root: &Path,
) -> Result<InstalledHealthIdentity, AdapterError> {
    let protocol_parent = protocol_root
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "protocol"))
        .ok_or_else(AdapterError::codex_unavailable)?;
    let install_root = protocol_parent
        .parent()
        .ok_or_else(AdapterError::codex_unavailable)?;
    let expected_uid = if install_root == Path::new("/opt/firecrawl") {
        0
    } else {
        effective_uid()?
    };
    let install_metadata =
        fs::metadata(install_root).map_err(|_| AdapterError::codex_unavailable())?;
    if !install_metadata.is_dir()
        || install_metadata.uid() != expected_uid
        || install_metadata.mode() & 0o022 != 0
    {
        return Err(AdapterError::codex_unavailable());
    }
    let current = install_root.join("current");
    let current_metadata =
        fs::symlink_metadata(&current).map_err(|_| AdapterError::codex_unavailable())?;
    let current_target = fs::read_link(&current).map_err(|_| AdapterError::codex_unavailable())?;
    let target_text = current_target
        .to_str()
        .ok_or_else(AdapterError::codex_unavailable)?;
    let generation_name = target_text
        .strip_prefix("generations/host-")
        .filter(|name| valid_sha256(name))
        .ok_or_else(AdapterError::codex_unavailable)?;
    if !current_metadata.file_type().is_symlink()
        || current_metadata.uid() != expected_uid
        || generation_name.is_empty()
    {
        return Err(AdapterError::codex_unavailable());
    }
    let stable_protocol = install_root.join("protocol");
    let stable_protocol_metadata =
        fs::symlink_metadata(&stable_protocol).map_err(|_| AdapterError::codex_unavailable())?;
    if !stable_protocol_metadata.file_type().is_symlink()
        || stable_protocol_metadata.uid() != expected_uid
        || fs::read_link(&stable_protocol).map_err(|_| AdapterError::codex_unavailable())?
            != Path::new("current/protocol")
    {
        return Err(AdapterError::codex_unavailable());
    }
    let generations = fs::canonicalize(install_root.join("generations"))
        .map_err(|_| AdapterError::codex_unavailable())?;
    let generation = fs::canonicalize(&current).map_err(|_| AdapterError::codex_unavailable())?;
    let generations_metadata =
        fs::metadata(&generations).map_err(|_| AdapterError::codex_unavailable())?;
    let generation_metadata =
        fs::metadata(&generation).map_err(|_| AdapterError::codex_unavailable())?;
    if generation.parent() != Some(generations.as_path())
        || !generations_metadata.is_dir()
        || !generation_metadata.is_dir()
        || generations_metadata.uid() != expected_uid
        || generation_metadata.uid() != expected_uid
        || generations_metadata.mode() & 0o022 != 0
        || generation_metadata.mode() & 0o022 != 0
    {
        return Err(AdapterError::codex_unavailable());
    }
    let canonical_protocol =
        fs::canonicalize(protocol_root).map_err(|_| AdapterError::codex_unavailable())?;
    if canonical_protocol != generation.join("protocol/codex-app-server") {
        return Err(AdapterError::codex_unavailable());
    }
    let manifest_raw =
        secure_regular_bytes(&generation.join("manifest.json"), expected_uid, 1 << 20)?;
    let manifest: InstalledManifest =
        parse_json_strict(&manifest_raw).map_err(|_| AdapterError::codex_unavailable())?;
    validate_installed_manifest(&manifest)?;
    verify_generation_checksums(&generation, expected_uid)?;
    verify_manifest_bindings(&generation, expected_uid, &manifest)?;
    crate::app_server::ProtocolBundle::load(protocol_root)
        .map_err(|_| AdapterError::codex_unavailable())?;
    crate::broker_client::validate_installed_contract_at(
        &protocol_parent.join("sandbox-broker-v1.contract.json"),
        expected_uid,
    )?;
    if manifest.codex_app_server.protocol_sha256
        != protocol_manifest_digest(protocol_root, expected_uid)?
    {
        return Err(AdapterError::codex_unavailable());
    }
    Ok(InstalledHealthIdentity {
        codex_cli_version: manifest.codex_app_server.source_identity.version,
        codex_artifact_sha256: manifest.codex_app_server.artifact_sha256,
        codex_protocol_schema_sha256: manifest.codex_app_server.protocol_sha256,
    })
}

fn verify_manifest_bindings(
    generation: &Path,
    expected_uid: u32,
    manifest: &InstalledManifest,
) -> Result<(), AdapterError> {
    if secure_regular_sha256(&generation.join("codex-app-server.tar"), expected_uid)?
        != manifest.codex_app_server.artifact_sha256
    {
        return Err(AdapterError::codex_unavailable());
    }
    for (name, expected) in &manifest.binary_hashes {
        if secure_regular_sha256(&generation.join("bin").join(name), expected_uid)? != *expected {
            return Err(AdapterError::codex_unavailable());
        }
    }
    for (name, expected) in &manifest.policy_hashes {
        if secure_regular_sha256(&generation.join("policy").join(name), expected_uid)? != *expected
        {
            return Err(AdapterError::codex_unavailable());
        }
    }
    for (bundle_id, expected) in &manifest.bundle_digests {
        let raw = secure_regular_bytes(
            &generation
                .join("bundles")
                .join(bundle_id)
                .join("rootfs.identity.json"),
            expected_uid,
            4096,
        )?;
        let identity: RootfsIdentity =
            parse_json_strict(&raw).map_err(|_| AdapterError::codex_unavailable())?;
        if identity.version != 1
            || identity.bundle_id != *bundle_id
            || identity.rootfs_sha256 != *expected
        {
            return Err(AdapterError::codex_unavailable());
        }
    }
    Ok(())
}

fn validate_installed_manifest(manifest: &InstalledManifest) -> Result<(), AdapterError> {
    let codex = &manifest.codex_app_server;
    let identity = &codex.source_identity;
    if manifest.format_version != 1
        || manifest.build_timestamp != codex.build_timestamp
        || manifest.broker_contract_sha256 != BROKER_CONTRACT_SHA256
        || codex.format_version != 1
        || codex.model != crate::app_server::MODEL
        || codex.reasoning_effort != crate::app_server::EFFORT
        || !valid_sha256(&codex.artifact_sha256)
        || !valid_sha256(&codex.protocol_sha256)
        || !valid_sha256(&codex.feature_sha256)
        || !valid_sha256(&codex.gate_attestation_sha256)
        || !valid_semver(&identity.version)
        || !Path::new(&identity.executable_path).is_absolute()
        || !Path::new(&identity.resolved_path).is_absolute()
        || identity.device.is_empty()
        || !identity.device.bytes().all(|byte| byte.is_ascii_digit())
        || identity.inode.is_empty()
        || !identity.inode.bytes().all(|byte| byte.is_ascii_digit())
        || manifest.code_runtime.node != "22.22.1"
        || manifest.code_runtime.python != "3.12.3"
        || manifest.code_runtime.bash != "5.2.21"
        || manifest.code_runtime.javascript_playwright != "1.61.1"
        || manifest.code_runtime.python_playwright != "1.61.0"
        || manifest.code_runtime.relay_protocol != "code-relay-v1"
        || manifest
            .bundle_digests
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != ["code-v1", "codex-v1"]
        || manifest
            .policy_hashes
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != ["bundles.json", "code-seccomp.json", "codex-seccomp.json"]
        || manifest
            .binary_hashes
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != [
                "acceptance-restart-broker",
                "firecrawl-browser-execution-adapter",
                "firecrawl-sandbox-broker",
            ]
        || manifest
            .bundle_digests
            .values()
            .chain(manifest.policy_hashes.values())
            .chain(manifest.binary_hashes.values())
            .any(|digest| !valid_sha256(digest))
    {
        return Err(AdapterError::codex_unavailable());
    }
    Ok(())
}

fn verify_generation_checksums(generation: &Path, expected_uid: u32) -> Result<(), AdapterError> {
    let sums = secure_regular_bytes(&generation.join("SHA256SUMS"), expected_uid, 4 << 20)?;
    let sums = std::str::from_utf8(&sums).map_err(|_| AdapterError::codex_unavailable())?;
    if sums.is_empty() || !sums.ends_with('\n') {
        return Err(AdapterError::codex_unavailable());
    }
    let mut previous: Option<&str> = None;
    for line in sums.lines() {
        let (digest, relative) = line
            .split_once("  ")
            .ok_or_else(AdapterError::codex_unavailable)?;
        if !valid_sha256(digest)
            || previous.is_some_and(|value| value >= relative)
            || !safe_relative_path(relative)
            || relative == "SHA256SUMS"
            || secure_regular_sha256(&generation.join(relative), expected_uid)? != digest
        {
            return Err(AdapterError::codex_unavailable());
        }
        previous = Some(relative);
    }
    Ok(())
}

fn protocol_manifest_digest(
    protocol_root: &Path,
    expected_uid: u32,
) -> Result<String, AdapterError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct ProtocolManifest {
        format_version: u8,
        codex_identity: InstalledCodexIdentity,
        schema_inventory: Vec<String>,
        schema_digest: String,
    }
    let raw = secure_regular_bytes(&protocol_root.join("manifest.json"), expected_uid, 1 << 20)?;
    let manifest: ProtocolManifest =
        parse_json_strict(&raw).map_err(|_| AdapterError::codex_unavailable())?;
    if manifest.format_version != 1
        || manifest.schema_inventory.is_empty()
        || !valid_semver(&manifest.codex_identity.version)
        || !valid_sha256(&manifest.schema_digest)
    {
        return Err(AdapterError::codex_unavailable());
    }
    Ok(manifest.schema_digest)
}

fn secure_regular_bytes(
    path: &Path,
    expected_uid: u32,
    maximum: usize,
) -> Result<Vec<u8>, AdapterError> {
    use std::io::Read;
    let mut file = secure_regular_file(path, expected_uid)?;
    let metadata = file
        .metadata()
        .map_err(|_| AdapterError::codex_unavailable())?;
    if metadata.len() > maximum as u64 {
        return Err(AdapterError::codex_unavailable());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AdapterError::codex_unavailable())?;
    if bytes.len() > maximum {
        return Err(AdapterError::codex_unavailable());
    }
    Ok(bytes)
}

fn secure_regular_sha256(path: &Path, expected_uid: u32) -> Result<String, AdapterError> {
    use std::io::Read;
    let mut file = secure_regular_file(path, expected_uid)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| AdapterError::codex_unavailable())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn secure_regular_file(path: &Path, expected_uid: u32) -> Result<fs::File, AdapterError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| AdapterError::codex_unavailable())?;
    let metadata = file
        .metadata()
        .map_err(|_| AdapterError::codex_unavailable())?;
    if !metadata.is_file()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o022 != 0
        || metadata.nlink() != 1
    {
        return Err(AdapterError::codex_unavailable());
    }
    Ok(file)
}

fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !Path::new(path).is_absolute()
        && path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'@' | b'-')
        })
        && Path::new(path)
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_semver(value: &str) -> bool {
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let core = &value[..core_end];
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == &"0" || !part.starts_with('0'))
        })
        && value[core_end..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn diagnose_result(
    diagnostic: BrokerDiagnostic,
    lifecycle: LifecycleCounts,
) -> DiagnoseHostJobResultBody {
    DiagnoseHostJobResultBody {
        version: VersionOne,
        correlation_id: diagnostic.correlation_id,
        job_id: diagnostic.job_id,
        phase: diagnostic.phase,
        host_init_pid: diagnostic.init_pid,
        pidfd_live: diagnostic.pidfd_live,
        pidfd_pid_matches: diagnostic.pidfd_pid_matches,
        control_lease_connected: diagnostic.control_lease_connected,
        inert_relay_fd_present: diagnostic.inert_relay_fd_present,
        relay_listener_present: diagnostic.relay_listener_present,
        cdp_relay_opened: diagnostic.cdp_relay_opened,
        payload_started_count: lifecycle.payload_started_count,
        payload_marker_present: diagnostic.payload_marker_present,
        callback_count: lifecycle.callback_count,
        browser_effect_count: lifecycle.browser_effect_count,
        runc_state: diagnostic.runc_state,
        cgroup_present: diagnostic.cgroup_present,
        job_directory_present: diagnostic.job_directory_present,
        child_count: diagnostic.child_count,
        cleanup_failure: diagnostic.cleanup_failure,
    }
}

async fn read_code_output<R>(reader: R) -> Result<String, AdapterError>
where
    R: AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    let mut exceeded = false;
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        if read == 0 {
            break;
        }
        if !exceeded && bytes.len() + read <= 262_144 {
            bytes.extend_from_slice(&chunk[..read]);
        } else {
            exceeded = true;
        }
    }
    if exceeded {
        return Err(AdapterError::sandbox_unavailable());
    }
    String::from_utf8(bytes).map_err(|_| AdapterError::sandbox_unavailable())
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
    lifecycle: JobLifecycle,
}

impl<R> AuditedReader<R> {
    fn new(
        inner: R,
        correlation_id: Uuid,
        job_id: Uuid,
        init_pid: u32,
        emitted: Arc<AtomicBool>,
        lifecycle: JobLifecycle,
    ) -> Self {
        Self {
            inner,
            correlation_id,
            job_id,
            init_pid,
            emitted,
            lifecycle,
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
            self.lifecycle.record_payload_started();
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

fn operation_has_browser_effect(operation: &BrowserOperation) -> bool {
    !matches!(
        operation,
        BrowserOperation::Snapshot
            | BrowserOperation::Wait { .. }
            | BrowserOperation::GetText { .. }
            | BrowserOperation::GetUrl
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::{
        JobCompletion, JobKind, JobRegistry, apply_broker_terminal_outcome, publish_boot_id,
        read_prior_boot_id,
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
        assert_eq!(*completion.borrow(), JobCompletion::Pending);
        assert!(registry.request_cancel(run_id).is_ok());
        assert!(registry.complete(
            run_id,
            binding,
            Some(crate::redaction::AdapterErrorCategory::Cancelled),
        ));
        assert_eq!(*completion.borrow(), JobCompletion::Proven);
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn code_completion_distinguishes_proven_from_cleanup_unproven() {
        let registry = JobRegistry::new(1, 2).unwrap();
        let unproven_run = Uuid::new_v4();
        let unproven_job = Uuid::new_v4();
        let unproven_correlation = Uuid::new_v4();
        let reserved = registry
            .reserve_correlated(
                unproven_run,
                JobKind::Code,
                unproven_job,
                Uuid::new_v4(),
                unproven_correlation,
            )
            .unwrap();
        reserved.lifecycle.record_payload_started();
        let unproven = registry.request_cancel(unproven_run).unwrap();
        assert!(!registry.complete_reserved(
            unproven_run,
            unproven_job,
            Some(AdapterErrorCategory::SandboxUnavailable),
        ));
        assert!(registry.fail_cleanup_reserved(unproven_run, unproven_job));
        assert_eq!(*unproven.borrow(), JobCompletion::CleanupUnproven);
        assert!(registry.terminal_jobs().is_empty());
        assert_eq!(
            registry
                .lifecycle_counts(unproven_correlation, unproven_job)
                .unwrap()
                .payload_started_count,
            1
        );

        let proven_run = Uuid::new_v4();
        let binding = AdapterAuthorizationBinding::new(Uuid::new_v4(), Uuid::new_v4(), 9).unwrap();
        registry.admit(proven_run, JobKind::Code, binding).unwrap();
        let proven = registry.request_cancel(proven_run).unwrap();
        assert!(!registry.complete(proven_run, binding, Some(AdapterErrorCategory::Cancelled),));
        assert!(
            registry.complete_code(proven_run, binding, Some(AdapterErrorCategory::Cancelled),)
        );
        assert_eq!(*proven.borrow(), JobCompletion::Proven);
        assert_eq!(registry.terminal_jobs().len(), 1);
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
