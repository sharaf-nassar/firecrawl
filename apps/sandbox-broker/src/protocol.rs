use std::collections::BTreeSet;

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::redaction::{BrokerError, BrokerResult, ErrorCategory};

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_JOB_WALL_TIME_MS: u64 = 300_000;
pub const SHARED_CONTRACT: &str =
    include_str!("../../../host/browser-runtime/protocol/sandbox-broker-v1.contract.json");
pub const SHARED_CONTRACT_SHA256: &str =
    "709ed34abc51ca9a9b44d96e1496667ac535ea8ff53d372d10817f4b613c48a1";
pub const INSTALLED_CONTRACT_PATH: &str = "/opt/firecrawl/protocol/sandbox-broker-v1.contract.json";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BundleId {
    CodexV1,
    CodeNodeV1,
    CodePythonV1,
    CodeBashV1,
}

impl BundleId {
    pub const ALL: [Self; 4] = [
        Self::CodexV1,
        Self::CodeNodeV1,
        Self::CodePythonV1,
        Self::CodeBashV1,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CodexV1 => "codex-v1",
            Self::CodeNodeV1 => "code-node-v1",
            Self::CodePythonV1 => "code-python-v1",
            Self::CodeBashV1 => "code-bash-v1",
        }
    }

    pub const fn descriptor_roles(self) -> &'static [&'static str] {
        match self {
            Self::CodexV1 => &["stdin", "stdout", "stderr", "auth", "config"],
            Self::CodeNodeV1 | Self::CodePythonV1 | Self::CodeBashV1 => {
                &["input", "stdout", "stderr", "relay"]
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    Cancelled,
    TimedOut,
    AuthorizationFailed,
    ProtocolError,
    Shutdown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrokerRequest {
    Prepare {
        job_id: Uuid,
        adapter_boot_id: Uuid,
        correlation_id: Uuid,
        bundle_id: BundleId,
        deadline_unix_ms: u64,
    },
    Cancel {
        job_id: Uuid,
        adapter_boot_id: Uuid,
        reason: CancelReason,
    },
    CancelOwner {
        adapter_boot_id: Uuid,
    },
    Diagnose {
        correlation_id: Uuid,
        job_id: Uuid,
    },
    Status,
    Health,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum PreparedControl {
    Start {
        job_id: Uuid,
        expected_init_pid: u32,
    },
    Abort {
        job_id: Uuid,
        reason: CancelReason,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Creating,
    Prepared,
    Starting,
    Running,
    Stopping,
    Terminal,
    Absent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuncState {
    Created,
    Running,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub artifact_id: Uuid,
    pub name: String,
    pub kind: String,
    pub content_type: String,
    pub byte_size: u64,
    pub checksum: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Diagnostic {
    pub correlation_id: Uuid,
    pub job_id: Uuid,
    pub phase: Phase,
    pub init_pid: Option<u32>,
    pub pidfd_live: bool,
    pub pidfd_pid_matches: bool,
    pub control_lease_connected: bool,
    pub inert_relay_fd_present: bool,
    pub relay_listener_present: bool,
    pub cdp_relay_opened: bool,
    pub payload_marker_present: bool,
    pub runc_state: Option<RuncState>,
    pub cgroup_present: bool,
    pub job_directory_present: bool,
    pub child_count: u32,
    pub cleanup_failure: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AggregateStatus {
    pub prepared_jobs: u32,
    pub starting_jobs: u32,
    pub running_jobs: u32,
    pub unsettled_jobs: u32,
    pub orphan_processes: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrokerResponse {
    Prepared {
        job_id: Uuid,
        init_pid: u32,
    },
    Started {
        job_id: Uuid,
        init_pid: u32,
    },
    Aborted {
        job_id: Uuid,
    },
    Terminal {
        job_id: Uuid,
        init_pid: u32,
        outcome: Outcome,
        artifacts: Vec<ArtifactRecord>,
    },
    Diagnostic {
        #[serde(flatten)]
        diagnostic: Diagnostic,
    },
    StatusResult {
        #[serde(flatten)]
        status: AggregateStatus,
    },
    OwnerCancelled,
    Healthy,
    Error {
        category: String,
        message: String,
    },
}

pub fn parse_request(bytes: &[u8]) -> BrokerResult<BrokerRequest> {
    roundtrip_closed(bytes)
}

pub fn parse_control(bytes: &[u8]) -> BrokerResult<PreparedControl> {
    roundtrip_closed(bytes)
}

fn roundtrip_closed<T>(bytes: &[u8]) -> BrokerResult<T>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let value = value_without_duplicate_keys(bytes)?;
    let parsed: T = serde_json::from_value(value.clone())
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let canonical = serde_json::to_value(&parsed)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if value != canonical {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(parsed)
}

pub fn strict_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> BrokerResult<T> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = T::deserialize(&mut deserializer)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    deserializer
        .end()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    Ok(value)
}

pub fn encode_response(response: &BrokerResponse) -> BrokerResult<Vec<u8>> {
    let bytes = serde_json::to_vec(response)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(bytes)
}

pub fn validate_request(request: &BrokerRequest) -> BrokerResult<()> {
    match request {
        BrokerRequest::Prepare {
            job_id,
            adapter_boot_id,
            correlation_id,
            deadline_unix_ms,
            ..
        } => {
            require_ids(&[*job_id, *adapter_boot_id, *correlation_id])?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            if now >= u128::from(*deadline_unix_ms)
                || u128::from(*deadline_unix_ms) > now + u128::from(MAX_JOB_WALL_TIME_MS)
            {
                return Err(BrokerError::new(ErrorCategory::InvalidRequest));
            }
        }
        BrokerRequest::Cancel {
            job_id,
            adapter_boot_id,
            ..
        } => require_ids(&[*job_id, *adapter_boot_id])?,
        BrokerRequest::CancelOwner { adapter_boot_id } => require_ids(&[*adapter_boot_id])?,
        BrokerRequest::Diagnose {
            correlation_id,
            job_id,
        } => require_ids(&[*correlation_id, *job_id])?,
        BrokerRequest::Status => {}
        BrokerRequest::Health => {}
    }
    Ok(())
}

fn require_ids(ids: &[Uuid]) -> BrokerResult<()> {
    if ids.iter().any(Uuid::is_nil) {
        Err(BrokerError::new(ErrorCategory::InvalidRequest))
    } else {
        Ok(())
    }
}

pub fn validate_shared_contract() -> BrokerResult<Value> {
    if contract_sha256(SHARED_CONTRACT.as_bytes()) != SHARED_CONTRACT_SHA256 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    validate_shared_contract_bytes(SHARED_CONTRACT.as_bytes())
}

pub fn validate_installed_contract() -> BrokerResult<Value> {
    validate_installed_contract_at(std::path::Path::new(INSTALLED_CONTRACT_PATH), 0)
}

pub fn validate_installed_contract_at(
    path: &std::path::Path,
    expected_uid: u32,
) -> BrokerResult<Value> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o022 != 0
        || metadata.nlink() != 1
        || metadata.len() > MAX_FRAME_BYTES as u64
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_FRAME_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if bytes.len() > MAX_FRAME_BYTES
        || contract_sha256(&bytes) != SHARED_CONTRACT_SHA256
        || bytes != SHARED_CONTRACT.as_bytes()
    {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    validate_shared_contract_bytes(&bytes)
}

fn contract_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn validate_shared_contract_bytes(bytes: &[u8]) -> BrokerResult<Value> {
    let contract = value_without_duplicate_keys(bytes)?;
    exact_keys(
        &contract,
        &["contractVersion", "messages", "phaseOrder", "transport"],
    )?;
    exact_keys(
        &contract["transport"],
        &[
            "encoding",
            "framing",
            "maxFrameBytes",
            "preparedControlLease",
        ],
    )?;
    if contract["contractVersion"] != 1
        || contract["transport"]["encoding"] != "utf-8-json"
        || contract["transport"]["framing"] != "seqpacket"
        || contract["transport"]["maxFrameBytes"] != MAX_FRAME_BYTES
        || contract["transport"]["preparedControlLease"] != "same-connection"
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    if contract["phaseOrder"]
        != serde_json::json!([
            "prepare",
            "prepared",
            "api_accepted",
            "api_authorized",
            "start",
            "started",
            "terminal"
        ])
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let messages = contract["messages"]
        .as_object()
        .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
    let expected_messages = [
        "abort",
        "aborted",
        "cancel",
        "cancel_owner",
        "diagnose",
        "diagnostic",
        "error",
        "health",
        "healthy",
        "owner_cancelled",
        "prepare",
        "prepared",
        "start",
        "started",
        "status",
        "status_result",
        "terminal",
    ];
    if messages.len() != expected_messages.len()
        || expected_messages
            .iter()
            .any(|name| !messages.contains_key(*name))
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    for name in expected_messages {
        let message = &messages[name];
        let prepare = name == "prepare";
        exact_keys(
            message,
            if prepare {
                &[
                    "descriptorRolesByBundle",
                    "direction",
                    "discriminator",
                    "requiredFields",
                ]
            } else {
                &[
                    "descriptorRoles",
                    "direction",
                    "discriminator",
                    "requiredFields",
                ]
            },
        )?;
        exact_keys(&message["discriminator"], &["field", "value"])?;
        let request = matches!(
            name,
            "prepare"
                | "start"
                | "abort"
                | "cancel"
                | "cancel_owner"
                | "diagnose"
                | "status"
                | "health"
        );
        let discriminator = if request { "method" } else { "type" };
        if message["direction"]
            != if request {
                "adapter_to_broker"
            } else {
                "broker_to_adapter"
            }
            || message["discriminator"]["field"] != discriminator
            || message["discriminator"]["value"] != name
        {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        let expected_fields: &[&str] = match name {
            "prepare" => &[
                "adapter_boot_id",
                "bundle_id",
                "correlation_id",
                "deadline_unix_ms",
                "job_id",
                "method",
            ],
            "prepared" | "started" => &["init_pid", "job_id", "type"],
            "start" => &["expected_init_pid", "job_id", "method"],
            "abort" => &["job_id", "method", "reason"],
            "aborted" => &["job_id", "type"],
            "cancel" => &["adapter_boot_id", "job_id", "method", "reason"],
            "cancel_owner" => &["adapter_boot_id", "method"],
            "diagnose" => &["correlation_id", "job_id", "method"],
            "diagnostic" => &[
                "cdp_relay_opened",
                "cgroup_present",
                "child_count",
                "cleanup_failure",
                "control_lease_connected",
                "correlation_id",
                "inert_relay_fd_present",
                "init_pid",
                "job_directory_present",
                "job_id",
                "payload_marker_present",
                "phase",
                "pidfd_live",
                "pidfd_pid_matches",
                "relay_listener_present",
                "runc_state",
                "type",
            ],
            "status" => &["method"],
            "status_result" => &[
                "orphan_processes",
                "prepared_jobs",
                "running_jobs",
                "starting_jobs",
                "type",
                "unsettled_jobs",
            ],
            "owner_cancelled" | "health" | "healthy" => &[discriminator],
            "terminal" => &["artifacts", "init_pid", "job_id", "outcome", "type"],
            "error" => &["category", "message", "type"],
            _ => return Err(BrokerError::new(ErrorCategory::InvalidRequest)),
        };
        let fields = message["requiredFields"]
            .as_array()
            .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
        let actual = fields
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
        if actual != expected_fields {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        if !prepare {
            let roles = message["descriptorRoles"]
                .as_array()
                .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
            if (name == "terminal" && roles.as_slice() != [serde_json::json!("artifacts")])
                || (name != "terminal" && !roles.is_empty())
            {
                return Err(BrokerError::new(ErrorCategory::InvalidRequest));
            }
        }
    }
    for bundle in BundleId::ALL {
        let roles = messages["prepare"]["descriptorRolesByBundle"][bundle.as_str()]
            .as_array()
            .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
        let actual = roles
            .iter()
            .map(|role| role.as_str())
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
        if actual != bundle.descriptor_roles()
            || actual.iter().collect::<BTreeSet<_>>().len() != actual.len()
        {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
    }
    validate_production_packets(&contract)?;
    Ok(contract)
}

fn value_without_duplicate_keys(bytes: &[u8]) -> BrokerResult<Value> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = NoDuplicateValue::deserialize(&mut deserializer)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?
        .0;
    deserializer
        .end()
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    Ok(value)
}

pub fn strict_json_value(bytes: &[u8]) -> BrokerResult<Value> {
    value_without_duplicate_keys(bytes)
}

struct NoDuplicateValue(Value);

impl<'de> Deserialize<'de> for NoDuplicateValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NoDuplicateVisitor)
    }
}

struct NoDuplicateVisitor;

impl<'de> Visitor<'de> for NoDuplicateVisitor {
    type Value = NoDuplicateValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JSON without duplicate object keys")
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::Bool(value)))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::Number(value.into())))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::Number(value.into())))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .map(NoDuplicateValue)
            .ok_or_else(|| E::custom("non-finite number"))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::String(value.to_owned())))
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::String(value)))
    }

    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::Null))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicateValue(Value::Null))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<NoDuplicateValue>()? {
            values.push(value.0);
        }
        Ok(NoDuplicateValue(Value::Array(values)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut values = serde_json::Map::new();
        while let Some((key, value)) = map.next_entry::<String, NoDuplicateValue>()? {
            if values.insert(key, value.0).is_some() {
                return Err(serde::de::Error::custom("duplicate object key"));
            }
        }
        Ok(NoDuplicateValue(Value::Object(values)))
    }
}

fn validate_production_packets(contract: &Value) -> BrokerResult<()> {
    let job_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let boot_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let correlation_id = Uuid::parse_str("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let requests = [
        serde_json::to_value(BrokerRequest::Prepare {
            job_id,
            adapter_boot_id: boot_id,
            correlation_id,
            bundle_id: BundleId::CodexV1,
            deadline_unix_ms: 1,
        }),
        serde_json::to_value(BrokerRequest::Cancel {
            job_id,
            adapter_boot_id: boot_id,
            reason: CancelReason::Cancelled,
        }),
        serde_json::to_value(BrokerRequest::CancelOwner {
            adapter_boot_id: boot_id,
        }),
        serde_json::to_value(BrokerRequest::Diagnose {
            correlation_id,
            job_id,
        }),
        serde_json::to_value(BrokerRequest::Status),
        serde_json::to_value(BrokerRequest::Health),
    ];
    let controls = [
        serde_json::to_value(PreparedControl::Start {
            job_id,
            expected_init_pid: 7,
        }),
        serde_json::to_value(PreparedControl::Abort {
            job_id,
            reason: CancelReason::AuthorizationFailed,
        }),
    ];
    let responses = [
        serde_json::to_value(BrokerResponse::Prepared {
            job_id,
            init_pid: 7,
        }),
        serde_json::to_value(BrokerResponse::Started {
            job_id,
            init_pid: 7,
        }),
        serde_json::to_value(BrokerResponse::Aborted { job_id }),
        serde_json::to_value(BrokerResponse::Terminal {
            job_id,
            init_pid: 7,
            outcome: Outcome::Completed,
            artifacts: Vec::new(),
        }),
        serde_json::to_value(BrokerResponse::OwnerCancelled),
        serde_json::to_value(BrokerResponse::StatusResult {
            status: AggregateStatus {
                prepared_jobs: 1,
                starting_jobs: 2,
                running_jobs: 3,
                unsettled_jobs: 4,
                orphan_processes: 5,
            },
        }),
        serde_json::to_value(BrokerResponse::Healthy),
        serde_json::to_value(BrokerResponse::Error {
            category: "invalid_request".to_owned(),
            message: "request rejected".to_owned(),
        }),
    ];
    for value in requests.into_iter().chain(controls).chain(responses) {
        let value = value
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
        validate_packet(&value, contract)?;
    }
    Ok(())
}

fn validate_packet(packet: &Value, contract: &Value) -> BrokerResult<()> {
    let object = packet
        .as_object()
        .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
    let (field, discriminator) = if let Some(method) = object.get("method") {
        ("method", method)
    } else {
        (
            "type",
            object
                .get("type")
                .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?,
        )
    };
    let name = discriminator
        .as_str()
        .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
    let message = &contract["messages"][name];
    if message.is_null()
        || message["discriminator"]["field"] != field
        || message["discriminator"]["value"] != name
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let required = message["requiredFields"]
        .as_array()
        .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
    if object.len() != required.len()
        || required
            .iter()
            .any(|key| key.as_str().is_none_or(|key| !object.contains_key(key)))
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn exact_keys(value: &Value, expected: &[&str]) -> BrokerResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| BrokerError::new(ErrorCategory::InvalidRequest))?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    use uuid::Uuid;

    #[test]
    fn installed_contract_is_bound_to_exact_regular_bytes() {
        let root = std::env::temp_dir().join(format!("broker-contract-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let contract = root.join("contract.json");
        fs::write(&contract, super::SHARED_CONTRACT).unwrap();
        fs::set_permissions(&contract, fs::Permissions::from_mode(0o600)).unwrap();
        let uid = fs::metadata(&contract).unwrap().uid();
        super::validate_installed_contract_at(&contract, uid).unwrap();

        fs::write(&contract, format!("{} ", super::SHARED_CONTRACT)).unwrap();
        assert!(super::validate_installed_contract_at(&contract, uid).is_err());
        fs::remove_file(&contract).unwrap();
        fs::write(root.join("target"), super::SHARED_CONTRACT).unwrap();
        symlink(root.join("target"), &contract).unwrap();
        assert!(super::validate_installed_contract_at(&contract, uid).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
