use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::decision::{
    DecisionDuplicateGuard, load_model_decision_envelope_schema, normalize_model_decision_envelope,
    parse_decision_envelope, validate_model_wire_schema_definition,
};
use crate::observations::{ObservationBudget, ObservationV1};
use crate::protocol::{ModelDecisionV1, parse_json_strict};
use crate::redaction::AdapterError;

pub const MAX_APP_SERVER_EVENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_APP_SERVER_STDERR_BYTES: usize = 256 * 1024;
pub const MAX_ACTIONS: u8 = 25;
pub const MAX_TURNS: u8 = 26;
pub const MAX_RUNTIME: Duration = Duration::from_secs(300);
pub const MODEL: &str = "gpt-5.6-terra";
pub const EFFORT: &str = "medium";
pub const WORK_DIRECTORY: &str = "/run/firecrawl-work";

const SCHEMA_LOGICAL_PREFIX: &str = "host/browser-runtime/protocol/codex-app-server/";
const REQUIRED_SCHEMAS: [&str; 7] = [
    "v1/InitializeResponse.json",
    "v2/ThreadStartResponse.json",
    "v2/TurnStartResponse.json",
    "v2/ThreadStartedNotification.json",
    "v2/TurnStartedNotification.json",
    "v2/ItemStartedNotification.json",
    "v2/ItemCompletedNotification.json",
];
const ADDITIONAL_REQUIRED_SCHEMAS: [&str; 6] = [
    "v2/TurnCompletedNotification.json",
    "v2/ThreadTokenUsageUpdatedNotification.json",
    "v2/AgentMessageDeltaNotification.json",
    "v2/ReasoningSummaryPartAddedNotification.json",
    "v2/ReasoningSummaryTextDeltaNotification.json",
    "v2/ReasoningTextDeltaNotification.json",
];

#[derive(Clone, Debug)]
pub struct ProtocolBundle {
    schemas: BTreeMap<String, Value>,
    model_decision_schema: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotManifest {
    #[serde(rename = "formatVersion")]
    format_version: u8,
    #[serde(rename = "codexIdentity")]
    codex_identity: CodexIdentity,
    #[serde(rename = "schemaInventory")]
    schema_inventory: Vec<String>,
    #[serde(rename = "schemaDigest")]
    schema_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CodexIdentity {
    #[serde(rename = "executablePath")]
    executable_path: String,
    #[serde(rename = "resolvedPath")]
    resolved_path: String,
    device: String,
    inode: String,
    version: String,
}

impl ProtocolBundle {
    pub fn load(root: &Path) -> Result<Self, AdapterError> {
        let root_metadata =
            fs::symlink_metadata(root).map_err(|_| AdapterError::model_protocol())?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(AdapterError::model_protocol());
        }
        let manifest_raw = read_regular_file(root, "manifest.json")?;
        let manifest: SnapshotManifest =
            parse_json_strict(&manifest_raw).map_err(|_| AdapterError::model_protocol())?;
        if manifest.format_version != 1
            || !valid_identity(&manifest.codex_identity)
            || !is_lower_hex(&manifest.schema_digest, 64)
            || !strict_sorted_unique_paths(&manifest.schema_inventory)
        {
            return Err(AdapterError::model_protocol());
        }

        let checksum_raw = read_regular_file(root, "SHA256SUMS")?;
        let checksum_text =
            std::str::from_utf8(&checksum_raw).map_err(|_| AdapterError::model_protocol())?;
        let checksums = parse_checksums(checksum_text)?;
        let expected_checksum_paths: BTreeSet<String> = manifest
            .schema_inventory
            .iter()
            .cloned()
            .chain(["model-decision-envelope-v1.schema.json".to_owned()])
            .collect();
        if checksums.keys().cloned().collect::<BTreeSet<_>>() != expected_checksum_paths {
            return Err(AdapterError::model_protocol());
        }

        let expected_files: BTreeSet<String> = expected_checksum_paths
            .iter()
            .cloned()
            .chain(["manifest.json".to_owned(), "SHA256SUMS".to_owned()])
            .collect();
        if collect_regular_files(root)? != expected_files {
            return Err(AdapterError::model_protocol());
        }

        let mut schemas = BTreeMap::new();
        let mut schema_digest = Sha256::new();
        for path in &manifest.schema_inventory {
            let raw = read_regular_file(root, path)?;
            if hex_sha256(&raw) != checksums[path] {
                return Err(AdapterError::model_protocol());
            }
            schema_digest.update(SCHEMA_LOGICAL_PREFIX.as_bytes());
            schema_digest.update(path.as_bytes());
            schema_digest.update([0]);
            schema_digest.update(&raw);
            schema_digest.update([0]);
            let schema = parse_json_strict(&raw).map_err(|_| AdapterError::model_protocol())?;
            schemas.insert(path.clone(), schema);
        }
        if format!("{:x}", schema_digest.finalize()) != manifest.schema_digest {
            return Err(AdapterError::model_protocol());
        }
        for required in REQUIRED_SCHEMAS
            .iter()
            .chain(ADDITIONAL_REQUIRED_SCHEMAS.iter())
        {
            if !schemas.contains_key(*required) {
                return Err(AdapterError::model_protocol());
            }
        }

        let model_raw = read_regular_file(root, "model-decision-envelope-v1.schema.json")?;
        if hex_sha256(&model_raw) != checksums["model-decision-envelope-v1.schema.json"] {
            return Err(AdapterError::model_protocol());
        }
        let model_decision_schema: Value =
            parse_json_strict(&model_raw).map_err(|_| AdapterError::model_protocol())?;
        validate_model_wire_schema_definition(&model_decision_schema)
            .map_err(|_| AdapterError::model_protocol())?;
        if model_decision_schema
            != load_model_decision_envelope_schema().map_err(|_| AdapterError::model_protocol())?
        {
            return Err(AdapterError::model_protocol());
        }
        Ok(Self {
            schemas,
            model_decision_schema,
        })
    }

    pub fn synthetic(schemas: BTreeMap<String, Value>) -> Result<Self, AdapterError> {
        for required in REQUIRED_SCHEMAS
            .iter()
            .chain(ADDITIONAL_REQUIRED_SCHEMAS.iter())
        {
            if !schemas.contains_key(*required) {
                return Err(AdapterError::model_protocol());
            }
        }
        Ok(Self {
            schemas,
            model_decision_schema: load_model_decision_envelope_schema()
                .map_err(|_| AdapterError::model_protocol())?,
        })
    }

    pub fn validate(&self, path: &str, value: &Value) -> Result<(), AdapterError> {
        let schema = self
            .schemas
            .get(path)
            .ok_or_else(AdapterError::model_protocol)?;
        if schema_matches(value, schema, schema, 0) {
            Ok(())
        } else {
            Err(AdapterError::model_protocol())
        }
    }

    pub fn model_decision_schema(&self) -> &Value {
        &self.model_decision_schema
    }
}

fn valid_identity(identity: &CodexIdentity) -> bool {
    Path::new(&identity.executable_path).is_absolute()
        && Path::new(&identity.resolved_path).is_absolute()
        && !identity.device.is_empty()
        && identity.device.bytes().all(|byte| byte.is_ascii_digit())
        && !identity.inode.is_empty()
        && identity.inode.bytes().all(|byte| byte.is_ascii_digit())
        && !identity.version.is_empty()
        && identity
            .version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn strict_sorted_unique_paths(paths: &[String]) -> bool {
    !paths.is_empty()
        && paths.windows(2).all(|pair| pair[0] < pair[1])
        && paths.iter().all(|path| safe_relative_json_path(path))
}

fn safe_relative_json_path(path: &str) -> bool {
    !path.is_empty()
        && path.ends_with(".json")
        && !Path::new(path).is_absolute()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn read_regular_file(root: &Path, relative: &str) -> Result<Vec<u8>, AdapterError> {
    if !safe_relative_path(relative) {
        return Err(AdapterError::model_protocol());
    }
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|_| AdapterError::model_protocol())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AdapterError::model_protocol());
    }
    fs::read(path).map_err(|_| AdapterError::model_protocol())
}

fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !Path::new(path).is_absolute()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn collect_regular_files(root: &Path) -> Result<BTreeSet<String>, AdapterError> {
    fn walk(root: &Path, current: &Path, files: &mut BTreeSet<String>) -> Result<(), AdapterError> {
        for entry in fs::read_dir(current).map_err(|_| AdapterError::model_protocol())? {
            let entry = entry.map_err(|_| AdapterError::model_protocol())?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| AdapterError::model_protocol())?;
            if metadata.file_type().is_symlink() {
                return Err(AdapterError::model_protocol());
            }
            if metadata.is_dir() {
                walk(root, &entry.path(), files)?;
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| AdapterError::model_protocol())?
                    .to_str()
                    .ok_or_else(AdapterError::model_protocol)?
                    .replace('\\', "/");
                if !files.insert(relative) {
                    return Err(AdapterError::model_protocol());
                }
            } else {
                return Err(AdapterError::model_protocol());
            }
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    walk(root, root, &mut files)?;
    Ok(files)
}

fn parse_checksums(input: &str) -> Result<BTreeMap<String, String>, AdapterError> {
    if input.is_empty() || !input.ends_with('\n') {
        return Err(AdapterError::model_protocol());
    }
    let mut values = BTreeMap::new();
    let mut previous: Option<String> = None;
    for line in input.lines() {
        let Some((digest, path)) = line.split_once("  ") else {
            return Err(AdapterError::model_protocol());
        };
        if !is_lower_hex(digest, 64)
            || !safe_relative_path(path)
            || previous
                .as_ref()
                .is_some_and(|prior| prior.as_str() >= path)
            || values.insert(path.to_owned(), digest.to_owned()).is_some()
        {
            return Err(AdapterError::model_protocol());
        }
        previous = Some(path.to_owned());
    }
    Ok(values)
}

fn hex_sha256(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

fn schema_matches(value: &Value, schema: &Value, root: &Value, depth: usize) -> bool {
    if depth > 128 {
        return false;
    }
    match schema {
        Value::Bool(value) => return *value,
        Value::Object(_) => {}
        _ => return false,
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let Some(name) = reference.strip_prefix("#/definitions/") else {
            return false;
        };
        let Some(target) = root
            .get("definitions")
            .and_then(|definitions| definitions.get(name))
        else {
            return false;
        };
        return schema_matches(value, target, root, depth + 1);
    }
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array)
        && !parts
            .iter()
            .all(|part| schema_matches(value, part, root, depth + 1))
    {
        return false;
    }
    if let Some(parts) = schema.get("anyOf").and_then(Value::as_array)
        && !parts
            .iter()
            .any(|part| schema_matches(value, part, root, depth + 1))
    {
        return false;
    }
    if let Some(parts) = schema.get("oneOf").and_then(Value::as_array)
        && parts
            .iter()
            .filter(|part| schema_matches(value, part, root, depth + 1))
            .count()
            != 1
    {
        return false;
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array)
        && !values.contains(value)
    {
        return false;
    }
    if let Some(expected) = schema.get("const")
        && expected != value
    {
        return false;
    }
    if let Some(types) = schema.get("type") {
        let matches = match types {
            Value::String(kind) => value_has_type(value, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| value_has_type(value, kind)),
            _ => false,
        };
        if !matches {
            return false;
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| length < minimum)
            || schema
                .get("maxLength")
                .and_then(Value::as_u64)
                .is_some_and(|maximum| length > maximum)
        {
            return false;
        }
    }
    if let Some(number) = value.as_f64() {
        if !number.is_finite()
            || schema
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|minimum| number < minimum)
            || schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|maximum| number > maximum)
        {
            return false;
        }
        if let Some(format) = schema.get("format").and_then(Value::as_str)
            && matches!(
                format,
                "int32" | "int64" | "uint" | "uint16" | "uint32" | "uint64"
            )
            && value.as_i64().is_none()
            && value.as_u64().is_none()
        {
            return false;
        }
    }
    if let Some(items) = value.as_array() {
        if schema
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| (items.len() as u64) < minimum)
            || schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|maximum| items.len() as u64 > maximum)
        {
            return false;
        }
        if let Some(item_schema) = schema.get("items")
            && !items
                .iter()
                .all(|item| schema_matches(item, item_schema, root, depth + 1))
        {
            return false;
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array)
            && required
                .iter()
                .filter_map(Value::as_str)
                .any(|name| !object.contains_key(name))
        {
            return false;
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        for (name, member) in object {
            if let Some(member_schema) = properties.and_then(|properties| properties.get(name)) {
                if !schema_matches(member, member_schema, root, depth + 1) {
                    return false;
                }
            } else {
                match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => return false,
                    Some(member_schema @ Value::Object(_)) => {
                        if !schema_matches(member, member_schema, root, depth + 1) {
                            return false;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    true
}

fn value_has_type(value: &Value, kind: &str) -> bool {
    match kind {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "string" => value.is_string(),
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub struct PromptJob {
    pub prompt: String,
    pub initial_observation: ObservationV1,
    pub deadline: Instant,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRunResult {
    pub output: String,
    pub turn_count: u8,
    pub action_count: u8,
    pub usage: PromptUsage,
    pub protocol: PromptProtocol,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptProtocol {
    pub tool_event_count: u8,
    pub approval_event_count: u8,
    pub decision_schema_version: u8,
    pub observation_schema_version: u8,
}

pub struct AppServer<R, W, E> {
    stdout: BufReader<R>,
    stdin: W,
    stderr: E,
    stderr_bytes: usize,
    stderr_eof: bool,
    current_turn_bytes: usize,
}

struct TurnAudit<'a> {
    bundle: &'a ProtocolBundle,
    thread_id: &'a str,
    turn_id: &'a str,
    usage: &'a mut PromptUsage,
}

impl<R, W, E> AppServer<R, W, E>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    E: AsyncRead + Unpin,
{
    pub fn new(stdout: R, stdin: W, stderr: E) -> Self {
        Self {
            stdout: BufReader::new(stdout),
            stdin,
            stderr,
            stderr_bytes: 0,
            stderr_eof: false,
            current_turn_bytes: 0,
        }
    }

    pub async fn run_prompt_job<F, Fut>(
        &mut self,
        bundle: &ProtocolBundle,
        job: PromptJob,
        mut execute_action: F,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<PromptRunResult, AdapterError>
    where
        F: FnMut(u8, crate::protocol::BrowserOperation) -> Fut,
        Fut: Future<Output = Result<ObservationV1, AdapterError>>,
    {
        let hard_deadline = job.deadline.min(Instant::now() + MAX_RUNTIME);
        self.write_json(
            &json!({"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "firecrawl-browser-adapter", "version": "1"},
                "capabilities": {"experimentalApi": true}
            }}),
            hard_deadline,
            &mut cancelled,
        )
        .await?;
        let initialize = self
            .read_response(1, hard_deadline, &mut cancelled, RejectEvents)
            .await?;
        bundle.validate("v1/InitializeResponse.json", &initialize)?;
        exact_object_keys(
            &initialize,
            &["codexHome", "platformFamily", "platformOs", "userAgent"],
        )?;
        self.write_json(
            &json!({"method": "initialized", "params": {}}),
            hard_deadline,
            &mut cancelled,
        )
        .await?;
        self.write_json(
            &json!({"id": 2, "method": "thread/start", "params": {
                "model": MODEL, "approvalPolicy": "never",
                "sandbox": "read-only", "cwd": WORK_DIRECTORY,
                "ephemeral": true, "allowProviderModelFallback": false,
                "dynamicTools": [], "environments": [],
                "experimentalRawEvents": false
            }}),
            hard_deadline,
            &mut cancelled,
        )
        .await?;
        let mut thread_events = Vec::new();
        let thread_response = self
            .read_response(2, hard_deadline, &mut cancelled, &mut thread_events)
            .await?;
        bundle.validate("v2/ThreadStartResponse.json", &thread_response)?;
        let thread_id = thread_response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(AdapterError::model_protocol)?
            .to_owned();
        for event in thread_events {
            if event.get("method").and_then(Value::as_str) != Some("thread/started") {
                return Err(AdapterError::model_protocol());
            }
            let params = event
                .get("params")
                .ok_or_else(AdapterError::model_protocol)?;
            bundle.validate("v2/ThreadStartedNotification.json", params)?;
            if params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                != Some(thread_id.as_str())
            {
                return Err(AdapterError::model_protocol());
            }
        }

        let mut turn_count = 0_u8;
        let mut action_count = 0_u8;
        let mut request_id = 3_u64;
        let mut budget = ObservationBudget::default();
        let mut duplicate_guard = DecisionDuplicateGuard::default();
        let mut turn_input = budget
            .build_initial_turn_input(&job.prompt, &job.initial_observation)
            .map_err(|_| AdapterError::model_protocol())?;
        let mut usage = PromptUsage::default();
        loop {
            turn_count = turn_count
                .checked_add(1)
                .filter(|count| *count <= MAX_TURNS)
                .ok_or_else(AdapterError::model_protocol)?;
            self.current_turn_bytes = 0;
            self.write_json(
                &json!({"id": request_id, "method": "turn/start", "params": {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": turn_input}],
                    "model": MODEL, "effort": EFFORT,
                    "approvalPolicy": "never", "cwd": WORK_DIRECTORY,
                    "environments": [], "outputSchema": bundle.model_decision_schema()
                }}),
                hard_deadline,
                &mut cancelled,
            )
            .await?;
            let mut pending = Vec::new();
            let turn_response = self
                .read_response(request_id, hard_deadline, &mut cancelled, &mut pending)
                .await?;
            bundle.validate("v2/TurnStartResponse.json", &turn_response)?;
            exact_object_keys(&turn_response, &["turn"])?;
            let turn_id = turn_response
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(AdapterError::model_protocol)?
                .to_owned();
            request_id += 1;

            let mut audit = TurnAudit {
                bundle,
                thread_id: &thread_id,
                turn_id: &turn_id,
                usage: &mut usage,
            };
            let decision_text = self
                .read_turn(&mut audit, hard_deadline, &mut cancelled, pending)
                .await?;
            self.reject_buffered_late_stdout()?;
            let envelope = parse_decision_envelope(&decision_text)
                .map_err(|_| AdapterError::model_protocol())?;
            let decision = normalize_model_decision_envelope(envelope);
            match decision {
                ModelDecisionV1::Final { output, .. } => {
                    return Ok(PromptRunResult {
                        output,
                        turn_count,
                        action_count,
                        usage,
                        protocol: PromptProtocol {
                            tool_event_count: 0,
                            approval_event_count: 0,
                            decision_schema_version: 1,
                            observation_schema_version: 1,
                        },
                    });
                }
                action @ ModelDecisionV1::Action { .. } => {
                    action_count = action_count
                        .checked_add(1)
                        .filter(|count| *count <= MAX_ACTIONS)
                        .ok_or_else(AdapterError::model_protocol)?;
                    duplicate_guard
                        .check_and_record(&action)
                        .map_err(|_| AdapterError::model_protocol())?;
                    let ModelDecisionV1::Action { action, .. } = action else {
                        unreachable!();
                    };
                    let action = execute_action(action_count, action);
                    tokio::pin!(action);
                    let observation = tokio::select! {
                        _ = tokio::time::sleep_until(hard_deadline) => {
                            return Err(AdapterError::timed_out());
                        }
                        changed = cancelled.changed() => {
                            let _ = changed;
                            return Err(AdapterError::cancelled());
                        }
                        observation = &mut action => observation?,
                    };
                    observation
                        .validate()
                        .map_err(|_| AdapterError::model_protocol())?;
                    turn_input = budget
                        .build_followup_turn_input(&observation)
                        .map_err(|_| AdapterError::model_protocol())?;
                }
            }
        }
    }

    pub async fn verify_terminated_stdout(
        &mut self,
        deadline: Instant,
    ) -> Result<(), AdapterError> {
        if !self.stdout.buffer().is_empty() {
            return Err(AdapterError::model_protocol());
        }
        let mut byte = [0_u8; 1];
        let read = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Err(AdapterError::timed_out()),
            read = self.stdout.read(&mut byte) => {
                read.map_err(|_| AdapterError::codex_unavailable())?
            }
        };
        if read == 0 {
            Ok(())
        } else {
            Err(AdapterError::model_protocol())
        }
    }

    async fn write_json(
        &mut self,
        value: &Value,
        deadline: Instant,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<(), AdapterError> {
        if *cancelled.borrow() {
            return Err(AdapterError::cancelled());
        }
        let mut bytes = serde_json::to_vec(value).map_err(|_| AdapterError::model_protocol())?;
        bytes.push(b'\n');
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Err(AdapterError::timed_out()),
            changed = cancelled.changed() => {
                let _ = changed;
                return Err(AdapterError::cancelled());
            }
            result = self.stdin.write_all(&bytes) => {
                result.map_err(|_| AdapterError::codex_unavailable())?;
            }
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => Err(AdapterError::timed_out()),
            changed = cancelled.changed() => {
                let _ = changed;
                Err(AdapterError::cancelled())
            }
            result = self.stdin.flush() => {
                result.map_err(|_| AdapterError::codex_unavailable())
            }
        }
    }

    async fn read_response(
        &mut self,
        expected_id: u64,
        deadline: Instant,
        cancelled: &mut watch::Receiver<bool>,
        mut pending: impl PendingEvents,
    ) -> Result<Value, AdapterError> {
        loop {
            let frame = self.read_frame(deadline, cancelled).await?;
            let object = frame.as_object().ok_or_else(AdapterError::model_protocol)?;
            if object.contains_key("method") {
                if object.contains_key("id") {
                    return Err(AdapterError::model_protocol());
                }
                exact_object_keys_optional(&frame, &["method", "params"], &["emittedAtMs"])?;
                pending.push_event(frame)?;
                continue;
            }
            if object.contains_key("error") {
                return Err(AdapterError::model_protocol());
            }
            exact_object_keys(&frame, &["id", "result"])?;
            if frame.get("id").and_then(Value::as_u64) != Some(expected_id) {
                return Err(AdapterError::model_protocol());
            }
            return frame
                .get("result")
                .cloned()
                .ok_or_else(AdapterError::model_protocol);
        }
    }

    async fn read_turn(
        &mut self,
        audit: &mut TurnAudit<'_>,
        deadline: Instant,
        cancelled: &mut watch::Receiver<bool>,
        pending: Vec<Value>,
    ) -> Result<String, AdapterError> {
        let mut agent_message: Option<String> = None;
        for event in pending {
            if let Some(output) = audit_turn_event(
                audit.bundle,
                event,
                audit.thread_id,
                audit.turn_id,
                audit.usage,
                &agent_message,
            )? {
                record_agent_message(&mut agent_message, output)?;
            }
        }
        loop {
            let event = self.read_frame(deadline, cancelled).await?;
            let object = event.as_object().ok_or_else(AdapterError::model_protocol)?;
            if object.contains_key("id") {
                return Err(AdapterError::model_protocol());
            }
            exact_object_keys_optional(&event, &["method", "params"], &["emittedAtMs"])?;
            let method = event
                .get("method")
                .and_then(Value::as_str)
                .ok_or_else(AdapterError::model_protocol)?;
            if method == "turn/completed" {
                audit
                    .bundle
                    .validate("v2/TurnCompletedNotification.json", &event["params"])?;
                validate_turn_completed(&event["params"], audit.thread_id, audit.turn_id)?;
                let output = agent_message.ok_or_else(AdapterError::model_protocol)?;
                return Ok(output);
            }
            if let Some(output) = audit_turn_event(
                audit.bundle,
                event,
                audit.thread_id,
                audit.turn_id,
                audit.usage,
                &agent_message,
            )? {
                record_agent_message(&mut agent_message, output)?;
            }
        }
    }

    fn reject_buffered_late_stdout(&self) -> Result<(), AdapterError> {
        if self.stdout.buffer().is_empty() {
            Ok(())
        } else {
            Err(AdapterError::model_protocol())
        }
    }

    async fn read_frame(
        &mut self,
        deadline: Instant,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<Value, AdapterError> {
        enum ReadEvent {
            Stdout(Vec<u8>, bool),
            Stderr(usize),
        }

        if *cancelled.borrow() {
            return Err(AdapterError::cancelled());
        }
        let mut line = Vec::new();
        loop {
            let mut stderr_chunk = [0_u8; 8_192];
            let event = tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return Err(AdapterError::timed_out()),
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() {
                        return Err(AdapterError::cancelled());
                    }
                    continue;
                }
                buffer = self.stdout.fill_buf() => {
                    let buffer = buffer.map_err(|_| AdapterError::codex_unavailable())?;
                    if buffer.is_empty() {
                        return Err(AdapterError::model_protocol());
                    }
                    let end = buffer
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .map_or(buffer.len(), |position| position + 1);
                    ReadEvent::Stdout(buffer[..end].to_vec(), end <= buffer.len()
                        && buffer.get(end.saturating_sub(1)) == Some(&b'\n'))
                }
                read = self.stderr.read(&mut stderr_chunk), if !self.stderr_eof => {
                    let read = read.map_err(|_| AdapterError::codex_unavailable())?;
                    ReadEvent::Stderr(read)
                }
            };
            match event {
                ReadEvent::Stdout(chunk, complete) => {
                    self.stdout.consume(chunk.len());
                    self.current_turn_bytes = self
                        .current_turn_bytes
                        .checked_add(chunk.len())
                        .filter(|bytes| *bytes <= MAX_APP_SERVER_EVENT_BYTES)
                        .ok_or_else(AdapterError::model_protocol)?;
                    line.extend_from_slice(&chunk);
                    if complete {
                        break;
                    }
                }
                ReadEvent::Stderr(0) => {
                    self.stderr_eof = true;
                }
                ReadEvent::Stderr(read) => {
                    self.stderr_bytes = self
                        .stderr_bytes
                        .checked_add(read)
                        .filter(|bytes| *bytes <= MAX_APP_SERVER_STDERR_BYTES)
                        .ok_or_else(AdapterError::model_protocol)?;
                }
            }
        }
        if line.len() > MAX_APP_SERVER_EVENT_BYTES || line.pop() != Some(b'\n') || line.is_empty() {
            return Err(AdapterError::model_protocol());
        }
        parse_json_strict(&line).map_err(|_| AdapterError::model_protocol())
    }
}

trait PendingEvents {
    fn push_event(&mut self, event: Value) -> Result<(), AdapterError>;
}

struct RejectEvents;

impl PendingEvents for RejectEvents {
    fn push_event(&mut self, _event: Value) -> Result<(), AdapterError> {
        Err(AdapterError::model_protocol())
    }
}

impl PendingEvents for Vec<Value> {
    fn push_event(&mut self, event: Value) -> Result<(), AdapterError> {
        self.push(event);
        Ok(())
    }
}

impl PendingEvents for &mut Vec<Value> {
    fn push_event(&mut self, event: Value) -> Result<(), AdapterError> {
        self.push(event);
        Ok(())
    }
}

fn record_agent_message(
    agent_message: &mut Option<String>,
    output: String,
) -> Result<(), AdapterError> {
    if agent_message.replace(output).is_some() {
        return Err(AdapterError::model_protocol());
    }
    Ok(())
}

fn audit_turn_event(
    bundle: &ProtocolBundle,
    event: Value,
    thread_id: &str,
    turn_id: &str,
    usage: &mut PromptUsage,
    existing_agent_message: &Option<String>,
) -> Result<Option<String>, AdapterError> {
    let method = event
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(AdapterError::model_protocol)?;
    if forbidden_method(method) {
        return Err(AdapterError::model_protocol());
    }
    let params = event
        .get("params")
        .ok_or_else(AdapterError::model_protocol)?;
    correlate_event(params, thread_id, turn_id)?;
    match method {
        "turn/started" => {
            exact_object_keys(params, &["threadId", "turn"])?;
            bundle.validate("v2/TurnStartedNotification.json", params)?;
            Ok(None)
        }
        "item/started" => {
            exact_object_keys(params, &["item", "startedAtMs", "threadId", "turnId"])?;
            bundle.validate("v2/ItemStartedNotification.json", params)?;
            ensure_allowed_item(params)?;
            Ok(None)
        }
        "item/completed" => {
            exact_object_keys(params, &["completedAtMs", "item", "threadId", "turnId"])?;
            bundle.validate("v2/ItemCompletedNotification.json", params)?;
            let item = ensure_allowed_item(params)?;
            if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
                return Ok(None);
            }
            if existing_agent_message.is_some() {
                return Err(AdapterError::model_protocol());
            }
            exact_map_keys_optional(item, &["id", "text", "type"], &["memoryCitation", "phase"])?;
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(AdapterError::model_protocol)?;
            Ok(Some(text.to_owned()))
        }
        "thread/tokenUsage/updated" => {
            exact_object_keys(params, &["threadId", "tokenUsage", "turnId"])?;
            bundle.validate("v2/ThreadTokenUsageUpdatedNotification.json", params)?;
            let total = params
                .get("tokenUsage")
                .and_then(|token_usage| token_usage.get("total"))
                .ok_or_else(AdapterError::model_protocol)?;
            usage.input_tokens = total
                .get("inputTokens")
                .and_then(Value::as_u64)
                .ok_or_else(AdapterError::model_protocol)?;
            usage.output_tokens = total
                .get("outputTokens")
                .and_then(Value::as_u64)
                .ok_or_else(AdapterError::model_protocol)?;
            Ok(None)
        }
        "item/agentMessage/delta" => {
            exact_object_keys(params, &["delta", "itemId", "threadId", "turnId"])?;
            bundle.validate("v2/AgentMessageDeltaNotification.json", params)?;
            Ok(None)
        }
        "item/reasoning/summaryPartAdded" => {
            exact_object_keys(params, &["itemId", "summaryIndex", "threadId", "turnId"])?;
            bundle.validate("v2/ReasoningSummaryPartAddedNotification.json", params)?;
            Ok(None)
        }
        "item/reasoning/summaryTextDelta" => {
            exact_object_keys(
                params,
                &["delta", "itemId", "summaryIndex", "threadId", "turnId"],
            )?;
            bundle.validate("v2/ReasoningSummaryTextDeltaNotification.json", params)?;
            Ok(None)
        }
        "item/reasoning/textDelta" => {
            exact_object_keys(
                params,
                &["contentIndex", "delta", "itemId", "threadId", "turnId"],
            )?;
            bundle.validate("v2/ReasoningTextDeltaNotification.json", params)?;
            Ok(None)
        }
        _ => Err(AdapterError::model_protocol()),
    }
}

fn ensure_allowed_item(params: &Value) -> Result<&Map<String, Value>, AdapterError> {
    let item = params
        .get("item")
        .and_then(Value::as_object)
        .ok_or_else(AdapterError::model_protocol)?;
    match item.get("type").and_then(Value::as_str) {
        Some("agentMessage" | "reasoning") => Ok(item),
        _ => Err(AdapterError::model_protocol()),
    }
}

fn correlate_event(params: &Value, thread_id: &str, turn_id: &str) -> Result<(), AdapterError> {
    if params
        .get("threadId")
        .is_some_and(|value| value.as_str() != Some(thread_id))
        || params
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .is_some_and(|value| value.as_str() != Some(thread_id))
        || params
            .get("turnId")
            .is_some_and(|value| value.as_str() != Some(turn_id))
        || params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .is_some_and(|value| value.as_str() != Some(turn_id))
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(())
}

fn validate_turn_completed(
    params: &Value,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), AdapterError> {
    correlate_event(params, thread_id, turn_id)?;
    exact_object_keys(params, &["threadId", "turn"])?;
    let turn = params
        .get("turn")
        .and_then(Value::as_object)
        .ok_or_else(AdapterError::model_protocol)?;
    let allowed = [
        "id",
        "status",
        "items",
        "itemsView",
        "startedAt",
        "completedAt",
        "durationMs",
        "error",
    ];
    if turn.keys().any(|key| !allowed.contains(&key.as_str()))
        || turn.get("status").and_then(Value::as_str) != Some("completed")
        || turn.get("error").is_some_and(|error| !error.is_null())
        || !matches!(
            turn.get("itemsView")
                .and_then(Value::as_str)
                .unwrap_or("full"),
            "notLoaded" | "summary" | "full"
        )
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(())
}

fn forbidden_method(method: &str) -> bool {
    let normalized = method.to_ascii_lowercase();
    [
        "command",
        "file",
        "mcp",
        "dynamictool",
        "dynamic_tool",
        "browser",
        "computer",
        "code",
        "websearch",
        "web_search",
        "image",
        "plugin",
        "shell",
        "approval",
        "collab",
        "hook",
        "requestuserinput",
    ]
    .iter()
    .any(|forbidden| normalized.contains(forbidden))
}

fn exact_object_keys(value: &Value, required: &[&str]) -> Result<(), AdapterError> {
    exact_object_keys_optional(value, required, &[])
}

fn exact_object_keys_optional(
    value: &Value,
    required: &[&str],
    optional: &[&str],
) -> Result<(), AdapterError> {
    let object = value.as_object().ok_or_else(AdapterError::model_protocol)?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(())
}

fn exact_map_keys_optional(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), AdapterError> {
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CodexIdentity, schema_matches, valid_identity};
    use serde_json::json;

    #[test]
    fn generated_schema_subset_validates_closed_shapes() {
        let schema = json!({
            "definitions": {"Id": {"type": "string", "minLength": 1}},
            "type": "object",
            "properties": {"id": {"$ref": "#/definitions/Id"}},
            "required": ["id"],
            "additionalProperties": false
        });
        assert!(schema_matches(&json!({"id": "x"}), &schema, &schema, 0));
        assert!(!schema_matches(
            &json!({"id": "", "extra": 1}),
            &schema,
            &schema,
            0
        ));
    }

    #[test]
    fn manifest_identity_requires_absolute_paths_and_numeric_identity() {
        assert!(valid_identity(&CodexIdentity {
            executable_path: "/bin/codex".to_owned(),
            resolved_path: "/opt/codex".to_owned(),
            device: "1".to_owned(),
            inode: "2".to_owned(),
            version: "0.145.0".to_owned(),
        }));
    }
}
