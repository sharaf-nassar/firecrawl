use std::io::{IoSlice, IoSliceMut, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};

use nix::cmsg_space;
use nix::fcntl::{FcntlArg, OFlag, SealFlag, fcntl};
use nix::sys::memfd::{MFdFlags, memfd_create};
use nix::sys::socket::{
    AddressFamily, ControlMessage, ControlMessageOwned, MsgFlags, Shutdown, SockFlag, SockType,
    UnixAddr, connect, recv, recvmsg, sendmsg, setsockopt, shutdown, socket, sockopt,
};
use nix::sys::time::{TimeVal, TimeValLike};
use nix::unistd::{Whence, dup, lseek, pipe2, write};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::unix::AsyncFd;
use tokio::net::unix::pipe::{Receiver, Sender};
use uuid::Uuid;

use crate::config::read_private_file;
use crate::protocol::parse_json_strict;
use crate::redaction::AdapterError;

const MAX_BROKER_FRAME_BYTES: usize = 64 * 1024;
const MAX_AUTH_BYTES: usize = 1024 * 1024;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_ARTIFACT_COUNT: usize = 8;
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const BROKER_IO_TIMEOUT_SECONDS: i64 = 30;
const CODEX_BUNDLE: &str = "codex-v1";
const BROKER_CONTRACT: &str =
    include_str!("../../../host/browser-runtime/protocol/sandbox-broker-v1.contract.json");
pub const BROKER_CONTRACT_SHA256: &str =
    "587c8e3da5f7050ec1a9ac2fd26a349b9fef7e82ddfd424f74a61172968700e4";
pub const INSTALLED_BROKER_CONTRACT_PATH: &str =
    "/opt/firecrawl/protocol/sandbox-broker-v1.contract.json";

pub const CODEX_CONFIG: &str = r#"model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[history]
persistence = "none"

[analytics]
enabled = false

[features]
apps = false
artifact = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode = false
code_mode_host = false
code_mode_only = false
computer_use = false
enable_mcp_apps = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
memories = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
request_permissions_tool = false
shell_snapshot = false
shell_tool = false
skill_mcp_dependency_install = false
skill_search = false
standalone_web_search = false
tool_call_mcp_elicitation = false
tool_suggest = false
unified_exec = false
workspace_dependencies = false
"#;

#[derive(Clone, Debug)]
pub struct BrokerClient {
    socket_path: PathBuf,
}

#[derive(Debug)]
pub struct PreparedCodex {
    pub job_id: Uuid,
    pub init_pid: u32,
    pub stdin: Option<Sender>,
    pub stdout: Option<Receiver>,
    pub stderr: Option<Receiver>,
    pub(crate) control: Option<OwnedFd>,
    pub(crate) started: bool,
}

pub struct PreparedLeaseMonitor {
    fd: AsyncFd<OwnedFd>,
    original_flags: OFlag,
}

pub struct PreparedStartInterrupter {
    fd: OwnedFd,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerArtifact {
    pub artifact_id: Uuid,
    pub name: String,
    pub kind: String,
    pub content_type: String,
    pub byte_size: u64,
    pub checksum: String,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerTerminal {
    pub outcome: BrokerTerminalOutcome,
    pub artifacts: Vec<BrokerArtifact>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ArtifactRecord {
    artifact_id: Uuid,
    name: String,
    kind: String,
    content_type: String,
    byte_size: u64,
    checksum: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BundleId {
    CodexV1,
    CodeNodeV1,
    CodePythonV1,
    CodeBashV1,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum BrokerRequest {
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
        reason: BrokerCancelReason,
    },
    CancelOwner {
        adapter_boot_id: Uuid,
    },
    Diagnose {
        correlation_id: Uuid,
        job_id: Uuid,
    },
    Health,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum PreparedControl {
    Start {
        job_id: Uuid,
        expected_init_pid: u32,
    },
    Abort {
        job_id: Uuid,
        reason: BrokerCancelReason,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerCancelReason {
    Cancelled,
    TimedOut,
    AuthorizationFailed,
    ProtocolError,
    Shutdown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum BrokerResponse {
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
        outcome: BrokerTerminalOutcome,
        artifacts: Vec<ArtifactRecord>,
    },
    Diagnostic {
        #[serde(flatten)]
        diagnostic: BrokerDiagnostic,
    },
    OwnerCancelled,
    Healthy,
    Error {
        category: String,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerTerminalOutcome {
    Completed,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerPhase {
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
pub enum BrokerRuncState {
    Created,
    Running,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BrokerDiagnostic {
    pub correlation_id: Uuid,
    pub job_id: Uuid,
    pub phase: BrokerPhase,
    pub init_pid: Option<u32>,
    pub pidfd_live: bool,
    pub pidfd_pid_matches: bool,
    pub control_lease_connected: bool,
    pub inert_relay_fd_present: bool,
    pub relay_listener_present: bool,
    pub cdp_relay_opened: bool,
    pub payload_marker_present: bool,
    pub runc_state: Option<BrokerRuncState>,
    pub cgroup_present: bool,
    pub job_directory_present: bool,
    pub child_count: u32,
    pub cleanup_failure: bool,
}

impl BrokerClient {
    pub fn new(socket_path: PathBuf) -> Result<Self, AdapterError> {
        if !socket_path.is_absolute() {
            return Err(AdapterError::sandbox_unavailable());
        }
        Ok(Self { socket_path })
    }

    pub fn prepare_codex(
        &self,
        job_id: Uuid,
        adapter_boot_id: Uuid,
        correlation_id: Uuid,
        deadline_unix_ms: u64,
        auth_file: &Path,
    ) -> Result<PreparedCodex, AdapterError> {
        if job_id.is_nil()
            || adapter_boot_id.is_nil()
            || correlation_id.is_nil()
            || deadline_unix_ms == 0
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        let auth = read_private_file(auth_file, MAX_AUTH_BYTES)
            .map_err(|_| AdapterError::codex_unavailable())?;
        parse_json_strict::<serde_json::Value>(&auth)
            .map_err(|_| AdapterError::codex_unavailable())?;
        if CODEX_CONFIG.len() > MAX_CONFIG_BYTES {
            return Err(AdapterError::codex_unavailable());
        }

        let (child_stdin, adapter_stdin) =
            pipe2(nix::fcntl::OFlag::O_CLOEXEC).map_err(|_| AdapterError::sandbox_unavailable())?;
        let (adapter_stdout, child_stdout) =
            pipe2(nix::fcntl::OFlag::O_CLOEXEC).map_err(|_| AdapterError::sandbox_unavailable())?;
        let (adapter_stderr, child_stderr) =
            pipe2(nix::fcntl::OFlag::O_CLOEXEC).map_err(|_| AdapterError::sandbox_unavailable())?;
        let auth_fd = sealed_memfd("firecrawl-codex-auth", &auth)?;
        let config_fd = sealed_memfd("firecrawl-codex-config", CODEX_CONFIG.as_bytes())?;
        let descriptor_roles = descriptor_roles(CODEX_BUNDLE)?;
        let descriptors = descriptor_roles
            .iter()
            .map(|role| match role.as_str() {
                "stdin" => Ok(child_stdin.as_raw_fd()),
                "stdout" => Ok(child_stdout.as_raw_fd()),
                "stderr" => Ok(child_stderr.as_raw_fd()),
                "auth" => Ok(auth_fd.as_raw_fd()),
                "config" => Ok(config_fd.as_raw_fd()),
                _ => Err(AdapterError::sandbox_unavailable()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let control = self.connect()?;
        self.send_request(
            &control,
            &BrokerRequest::Prepare {
                job_id,
                adapter_boot_id,
                correlation_id,
                bundle_id: BundleId::CodexV1,
                deadline_unix_ms,
            },
            &descriptors,
        )?;
        let response = self.receive_response(&control)?;
        let (returned_job_id, init_pid) = match response {
            BrokerResponse::Prepared { job_id, init_pid } => (job_id, init_pid),
            _ => {
                self.abort_invalid_prepare(&control, job_id);
                return Err(AdapterError::sandbox_unavailable());
            }
        };
        if returned_job_id != job_id || init_pid == 0 {
            self.abort_invalid_prepare(&control, job_id);
            return Err(AdapterError::sandbox_unavailable());
        }
        let stdin = Sender::from_owned_fd(adapter_stdin)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let stdout = Receiver::from_owned_fd(adapter_stdout)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let stderr = Receiver::from_owned_fd(adapter_stderr)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        Ok(PreparedCodex {
            job_id,
            init_pid,
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr: Some(stderr),
            control: Some(control),
            started: false,
        })
    }

    pub fn start(&self, prepared: &mut PreparedCodex) -> Result<(), AdapterError> {
        let control = prepared
            .control
            .as_ref()
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        self.send_request(
            control,
            &PreparedControl::Start {
                job_id: prepared.job_id,
                expected_init_pid: prepared.init_pid,
            },
            &[],
        )?;
        let response = self.receive_response(control)?;
        match response {
            BrokerResponse::Started {
                job_id: returned_job_id,
                init_pid,
            } if returned_job_id == prepared.job_id && init_pid == prepared.init_pid => {
                prepared.started = true;
                Ok(())
            }
            _ => {
                self.abort(prepared, BrokerCancelReason::ProtocolError)?;
                Err(AdapterError::sandbox_unavailable())
            }
        }
    }

    pub fn start_interrupter(
        &self,
        prepared: &PreparedCodex,
    ) -> Result<PreparedStartInterrupter, AdapterError> {
        let control = prepared
            .control
            .as_ref()
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        let fd = dup(control).map_err(|_| AdapterError::sandbox_unavailable())?;
        Ok(PreparedStartInterrupter { fd })
    }

    pub fn monitor_prepared(
        &self,
        prepared: &PreparedCodex,
    ) -> Result<PreparedLeaseMonitor, AdapterError> {
        let control = prepared
            .control
            .as_ref()
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        let original_flags = OFlag::from_bits_truncate(
            fcntl(control, FcntlArg::F_GETFL).map_err(|_| AdapterError::sandbox_unavailable())?,
        );
        fcntl(
            control,
            FcntlArg::F_SETFL(original_flags | OFlag::O_NONBLOCK),
        )
        .map_err(|_| AdapterError::sandbox_unavailable())?;
        let duplicate = match dup(control) {
            Ok(duplicate) => duplicate,
            Err(_) => {
                let _ = fcntl(control, FcntlArg::F_SETFL(original_flags));
                return Err(AdapterError::sandbox_unavailable());
            }
        };
        let fd = match AsyncFd::new(duplicate) {
            Ok(fd) => fd,
            Err(_) => {
                let _ = fcntl(control, FcntlArg::F_SETFL(original_flags));
                return Err(AdapterError::sandbox_unavailable());
            }
        };
        Ok(PreparedLeaseMonitor { fd, original_flags })
    }

    pub fn ensure_prepared_lease_quiet(
        &self,
        prepared: &PreparedCodex,
    ) -> Result<(), AdapterError> {
        let control = prepared
            .control
            .as_ref()
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        let mut byte = [0_u8; 1];
        match recv(
            control.as_raw_fd(),
            &mut byte,
            MsgFlags::MSG_PEEK | MsgFlags::MSG_DONTWAIT,
        ) {
            Err(nix::errno::Errno::EAGAIN) => Ok(()),
            _ => Err(AdapterError::sandbox_unavailable()),
        }
    }

    pub fn abort(
        &self,
        prepared: &mut PreparedCodex,
        reason: BrokerCancelReason,
    ) -> Result<(), AdapterError> {
        let Some(control) = prepared.control.take() else {
            return Ok(());
        };
        self.send_request(
            &control,
            &PreparedControl::Abort {
                job_id: prepared.job_id,
                reason,
            },
            &[],
        )?;
        match self.receive_response(&control)? {
            BrokerResponse::Aborted {
                job_id: returned_job_id,
            } if returned_job_id == prepared.job_id => Ok(()),
            _ => Err(AdapterError::sandbox_unavailable()),
        }
    }

    pub fn finish(
        &self,
        prepared: &mut PreparedCodex,
        adapter_boot_id: Uuid,
        reason: BrokerCancelReason,
    ) -> Result<BrokerTerminal, AdapterError> {
        let control = prepared
            .control
            .as_ref()
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        let _cancel_send_result = self.send_request(
            control,
            &BrokerRequest::Cancel {
                job_id: prepared.job_id,
                adapter_boot_id,
                reason,
            },
            &[],
        );
        let (response, artifacts) = self.receive_terminal_response(control)?;
        match response {
            BrokerResponse::Terminal {
                job_id,
                init_pid,
                outcome,
                ..
            } if job_id == prepared.job_id && init_pid == prepared.init_pid => {
                prepared.control.take();
                if terminal_outcome_allowed_for_reason(reason, outcome) {
                    Ok(BrokerTerminal { outcome, artifacts })
                } else {
                    Err(AdapterError::sandbox_unavailable())
                }
            }
            _ => Err(AdapterError::sandbox_unavailable()),
        }
    }

    pub fn cancel_owner(&self, adapter_boot_id: Uuid) -> Result<(), AdapterError> {
        match self.exchange_one_shot(&BrokerRequest::CancelOwner { adapter_boot_id })? {
            BrokerResponse::OwnerCancelled => Ok(()),
            _ => Err(AdapterError::sandbox_unavailable()),
        }
    }

    pub fn health(&self) -> Result<(), AdapterError> {
        match self.exchange_one_shot(&BrokerRequest::Health)? {
            BrokerResponse::Healthy => Ok(()),
            _ => Err(AdapterError::sandbox_unavailable()),
        }
    }

    pub fn diagnose(
        &self,
        correlation_id: Uuid,
        job_id: Uuid,
    ) -> Result<BrokerDiagnostic, AdapterError> {
        if correlation_id.is_nil() || job_id.is_nil() {
            return Err(AdapterError::sandbox_unavailable());
        }
        match self.exchange_one_shot(&BrokerRequest::Diagnose {
            correlation_id,
            job_id,
        })? {
            BrokerResponse::Diagnostic { diagnostic }
                if diagnostic.correlation_id == correlation_id && diagnostic.job_id == job_id =>
            {
                Ok(diagnostic)
            }
            _ => Err(AdapterError::sandbox_unavailable()),
        }
    }

    fn connect(&self) -> Result<OwnedFd, AdapterError> {
        let socket_fd = socket(
            AddressFamily::Unix,
            SockType::SeqPacket,
            SockFlag::SOCK_CLOEXEC,
            None,
        )
        .map_err(|_| AdapterError::sandbox_unavailable())?;
        let address =
            UnixAddr::new(&self.socket_path).map_err(|_| AdapterError::sandbox_unavailable())?;
        connect(socket_fd.as_raw_fd(), &address)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let timeout = TimeVal::seconds(BROKER_IO_TIMEOUT_SECONDS);
        setsockopt(&socket_fd, sockopt::ReceiveTimeout, &timeout)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        setsockopt(&socket_fd, sockopt::SendTimeout, &timeout)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        Ok(socket_fd)
    }

    fn exchange_one_shot(&self, request: &BrokerRequest) -> Result<BrokerResponse, AdapterError> {
        let socket_fd = self.connect()?;
        self.send_request(&socket_fd, request, &[])?;
        self.receive_response(&socket_fd)
    }

    fn abort_invalid_prepare(&self, control: &OwnedFd, job_id: Uuid) {
        let _ = self.send_request(
            control,
            &PreparedControl::Abort {
                job_id,
                reason: BrokerCancelReason::ProtocolError,
            },
            &[],
        );
        let _ = self.receive_response(control);
    }

    fn send_request<T: Serialize>(
        &self,
        socket_fd: &OwnedFd,
        request: &T,
        descriptors: &[i32],
    ) -> Result<(), AdapterError> {
        let frame = serde_json::to_vec(request).map_err(|_| AdapterError::sandbox_unavailable())?;
        if frame.len() > MAX_BROKER_FRAME_BYTES {
            return Err(AdapterError::sandbox_unavailable());
        }
        let iov = [IoSlice::new(&frame)];
        if descriptors.is_empty() {
            sendmsg::<UnixAddr>(socket_fd.as_raw_fd(), &iov, &[], MsgFlags::empty(), None)
                .map_err(|_| AdapterError::sandbox_unavailable())?;
        } else {
            let control = [ControlMessage::ScmRights(descriptors)];
            sendmsg::<UnixAddr>(
                socket_fd.as_raw_fd(),
                &iov,
                &control,
                MsgFlags::empty(),
                None,
            )
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        }
        Ok(())
    }

    fn receive_response(&self, socket_fd: &OwnedFd) -> Result<BrokerResponse, AdapterError> {
        let (response, descriptors) = self.receive_response_packet(socket_fd)?;
        if !descriptors.is_empty() {
            return Err(AdapterError::sandbox_unavailable());
        }
        Ok(response)
    }

    fn receive_terminal_response(
        &self,
        socket_fd: &OwnedFd,
    ) -> Result<(BrokerResponse, Vec<BrokerArtifact>), AdapterError> {
        let (response, descriptors) = self.receive_response_packet(socket_fd)?;
        let BrokerResponse::Terminal {
            outcome, artifacts, ..
        } = &response
        else {
            return Err(AdapterError::sandbox_unavailable());
        };
        if *outcome != BrokerTerminalOutcome::Completed
            && (!artifacts.is_empty() || !descriptors.is_empty())
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        let artifacts = validate_terminal_artifacts(artifacts, descriptors)?;
        Ok((response, artifacts))
    }

    fn receive_response_packet(
        &self,
        socket_fd: &OwnedFd,
    ) -> Result<(BrokerResponse, Vec<OwnedFd>), AdapterError> {
        let mut response = vec![0_u8; MAX_BROKER_FRAME_BYTES + 1];
        let (read, received_descriptors) = {
            let mut iov = [IoSliceMut::new(&mut response)];
            let mut control = cmsg_space!([RawFd; 253], nix::libc::ucred);
            let message = recvmsg::<()>(
                socket_fd.as_raw_fd(),
                &mut iov,
                Some(&mut control),
                MsgFlags::MSG_CMSG_CLOEXEC,
            )
            .map_err(|_| AdapterError::sandbox_unavailable())?;
            let read = message.bytes;
            let flags = message.flags;
            let mut unexpected_control = false;
            let mut received_descriptors = Vec::new();
            for control_message in message
                .cmsgs()
                .map_err(|_| AdapterError::sandbox_unavailable())?
            {
                match control_message {
                    ControlMessageOwned::ScmRights(descriptors) => {
                        received_descriptors.extend(
                            descriptors
                                .into_iter()
                                .map(|descriptor| unsafe { OwnedFd::from_raw_fd(descriptor) }),
                        );
                    }
                    _ => unexpected_control = true,
                }
            }
            validate_response_transport(flags, unexpected_control)?;
            (read, received_descriptors)
        };
        if read == 0 || read > MAX_BROKER_FRAME_BYTES {
            return Err(AdapterError::sandbox_unavailable());
        }
        response.truncate(read);
        let parsed: BrokerResponse =
            parse_json_strict(&response).map_err(|_| AdapterError::sandbox_unavailable())?;
        if let BrokerResponse::Error { category, message } = &parsed {
            let _ = (category, message);
            return Err(AdapterError::sandbox_unavailable());
        }
        Ok((parsed, received_descriptors))
    }
}

const fn terminal_outcome_allowed_for_reason(
    reason: BrokerCancelReason,
    outcome: BrokerTerminalOutcome,
) -> bool {
    matches!(
        (reason, outcome),
        (
            BrokerCancelReason::Shutdown,
            BrokerTerminalOutcome::Completed
        ) | (
            BrokerCancelReason::Cancelled,
            BrokerTerminalOutcome::Cancelled
        ) | (
            _,
            BrokerTerminalOutcome::TimedOut | BrokerTerminalOutcome::Failed
        )
    )
}

fn validate_terminal_artifacts(
    records: &[ArtifactRecord],
    descriptors: Vec<OwnedFd>,
) -> Result<Vec<BrokerArtifact>, AdapterError> {
    if records.len() > MAX_ARTIFACT_COUNT || descriptors.len() != records.len() {
        return Err(AdapterError::sandbox_unavailable());
    }
    let required_seals = SealFlag::F_SEAL_WRITE
        | SealFlag::F_SEAL_GROW
        | SealFlag::F_SEAL_SHRINK
        | SealFlag::F_SEAL_SEAL;
    let mut ids = std::collections::BTreeSet::new();
    let mut names = std::collections::BTreeSet::new();
    let mut total = 0_u64;
    let mut output = Vec::with_capacity(records.len());
    for (record, descriptor) in records.iter().zip(descriptors) {
        if record.artifact_id.is_nil()
            || !ids.insert(record.artifact_id)
            || !names.insert(record.name.as_str())
            || !safe_artifact_name(&record.name)
            || !valid_artifact_kind_content_type(&record.kind, &record.content_type)
            || !valid_checksum(&record.checksum)
            || record.byte_size == 0
            || record.byte_size > MAX_ARTIFACT_BYTES
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        total = total
            .checked_add(record.byte_size)
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        if total > MAX_ARTIFACT_TOTAL_BYTES {
            return Err(AdapterError::sandbox_unavailable());
        }
        let target = std::fs::read_link(format!("/proc/self/fd/{}", descriptor.as_raw_fd()))
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let expected_target = format!("/memfd:firecrawl-artifact-{} (deleted)", record.artifact_id);
        if target.as_os_str() != std::ffi::OsStr::new(&expected_target)
            || fcntl(&descriptor, FcntlArg::F_GET_SEALS)
                .ok()
                .and_then(SealFlag::from_bits)
                != Some(required_seals)
            || lseek(&descriptor, 0, Whence::SeekCur).ok() != Some(0)
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        let mut file = std::fs::File::from(descriptor);
        let metadata = file
            .metadata()
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        if !metadata.file_type().is_file() || metadata.len() != record.byte_size {
            return Err(AdapterError::sandbox_unavailable());
        }
        let mut content = Vec::with_capacity(record.byte_size as usize);
        file.read_to_end(&mut content)
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        if content.len() as u64 != record.byte_size
            || hex_sha256(&content) != record.checksum
            || !valid_artifact_content(&record.content_type, &content)
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        output.push(BrokerArtifact {
            artifact_id: record.artifact_id,
            name: record.name.clone(),
            kind: record.kind.clone(),
            content_type: record.content_type.clone(),
            byte_size: record.byte_size,
            checksum: record.checksum.clone(),
            content,
        });
    }
    Ok(output)
}

fn safe_artifact_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_artifact_kind_content_type(kind: &str, content_type: &str) -> bool {
    matches!(
        (kind, content_type),
        ("screenshot", "image/png")
            | ("screenshot", "image/jpeg")
            | ("trace", "application/zip")
            | ("recording", "video/webm")
    )
}

fn valid_checksum(checksum: &str) -> bool {
    checksum.len() == 64
        && checksum
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_artifact_content(content_type: &str, content: &[u8]) -> bool {
    match content_type {
        "image/jpeg" => content.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => content.starts_with(b"\x89PNG\r\n\x1a\n"),
        "application/zip" => {
            content.starts_with(b"PK\x03\x04")
                || content.starts_with(b"PK\x05\x06")
                || content.starts_with(b"PK\x07\x08")
        }
        "video/webm" => content.starts_with(b"\x1a\x45\xdf\xa3"),
        _ => false,
    }
}

fn hex_sha256(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_response_transport(flags: MsgFlags, control_present: bool) -> Result<(), AdapterError> {
    if flags.intersects(MsgFlags::MSG_TRUNC | MsgFlags::MSG_CTRUNC) || control_present {
        Err(AdapterError::sandbox_unavailable())
    } else {
        Ok(())
    }
}

impl PreparedLeaseMonitor {
    pub async fn wait_for_failure(&self) -> AdapterError {
        loop {
            let mut readiness = match self.fd.readable().await {
                Ok(readiness) => readiness,
                Err(_) => return AdapterError::sandbox_unavailable(),
            };
            let result = readiness.try_io(|fd| {
                let mut byte = [0_u8; 1];
                match recv(
                    fd.get_ref().as_raw_fd(),
                    &mut byte,
                    MsgFlags::MSG_PEEK | MsgFlags::MSG_DONTWAIT,
                ) {
                    Err(nix::errno::Errno::EAGAIN) => {
                        Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
                    }
                    Ok(_) => Ok(()),
                    Err(error) => Err(std::io::Error::from_raw_os_error(error as i32)),
                }
            });
            match result {
                Ok(_) => return AdapterError::sandbox_unavailable(),
                Err(_would_block) => continue,
            }
        }
    }
}

impl PreparedStartInterrupter {
    pub fn interrupt(self) -> Result<(), AdapterError> {
        shutdown(self.fd.as_raw_fd(), Shutdown::Both)
            .map_err(|_| AdapterError::sandbox_unavailable())
    }
}

impl Drop for PreparedLeaseMonitor {
    fn drop(&mut self) {
        let _ = fcntl(self.fd.get_ref(), FcntlArg::F_SETFL(self.original_flags));
    }
}

impl Drop for PreparedCodex {
    fn drop(&mut self) {
        if self.started {
            return;
        }
        let Some(control) = self.control.take() else {
            return;
        };
        let Ok(frame) = serde_json::to_vec(&PreparedControl::Abort {
            job_id: self.job_id,
            reason: BrokerCancelReason::AuthorizationFailed,
        }) else {
            return;
        };
        let iov = [IoSlice::new(&frame)];
        let _ = sendmsg::<UnixAddr>(control.as_raw_fd(), &iov, &[], MsgFlags::MSG_DONTWAIT, None);
    }
}

fn sealed_memfd(name: &str, contents: &[u8]) -> Result<OwnedFd, AdapterError> {
    let fd = memfd_create(name, MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING)
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let mut offset = 0;
    while offset < contents.len() {
        let written =
            write(&fd, &contents[offset..]).map_err(|_| AdapterError::sandbox_unavailable())?;
        if written == 0 {
            return Err(AdapterError::sandbox_unavailable());
        }
        offset += written;
    }
    fcntl(
        &fd,
        FcntlArg::F_ADD_SEALS(
            SealFlag::F_SEAL_WRITE
                | SealFlag::F_SEAL_GROW
                | SealFlag::F_SEAL_SHRINK
                | SealFlag::F_SEAL_SEAL,
        ),
    )
    .map_err(|_| AdapterError::sandbox_unavailable())?;
    Ok(fd)
}

fn descriptor_roles(bundle_id: &str) -> Result<Vec<String>, AdapterError> {
    let contract = validate_shared_contract_bytes(BROKER_CONTRACT.as_bytes())?;
    let roles = contract
        .pointer("/messages/prepare/descriptorRolesByBundle")
        .and_then(|value| value.get(bundle_id))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    let roles = roles
        .iter()
        .map(|role| {
            role.as_str()
                .filter(|role| !role.is_empty())
                .map(str::to_owned)
                .ok_or_else(AdapterError::sandbox_unavailable)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let unique = roles.iter().collect::<std::collections::BTreeSet<_>>();
    if unique.len() != roles.len() {
        return Err(AdapterError::sandbox_unavailable());
    }
    Ok(roles)
}

pub fn validate_shared_contract() -> Result<(), AdapterError> {
    if hex_sha256(BROKER_CONTRACT.as_bytes()) != BROKER_CONTRACT_SHA256 {
        return Err(AdapterError::sandbox_unavailable());
    }
    let contract = validate_shared_contract_bytes(BROKER_CONTRACT.as_bytes())?;
    if descriptor_roles(CODEX_BUNDLE)? != ["stdin", "stdout", "stderr", "auth", "config"] {
        return Err(AdapterError::sandbox_unavailable());
    }
    let job_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let boot_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let correlation_id = Uuid::parse_str("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let packets = [
        serde_json::to_value(BrokerRequest::Prepare {
            job_id,
            adapter_boot_id: boot_id,
            correlation_id,
            bundle_id: BundleId::CodexV1,
            deadline_unix_ms: 1,
        }),
        serde_json::to_value(PreparedControl::Start {
            job_id,
            expected_init_pid: 7,
        }),
        serde_json::to_value(PreparedControl::Abort {
            job_id,
            reason: BrokerCancelReason::AuthorizationFailed,
        }),
        serde_json::to_value(BrokerRequest::Cancel {
            job_id,
            adapter_boot_id: boot_id,
            reason: BrokerCancelReason::Cancelled,
        }),
        serde_json::to_value(BrokerRequest::CancelOwner {
            adapter_boot_id: boot_id,
        }),
        serde_json::to_value(BrokerRequest::Diagnose {
            correlation_id,
            job_id,
        }),
        serde_json::to_value(BrokerRequest::Health),
    ];
    for packet in packets {
        let packet = packet.map_err(|_| AdapterError::sandbox_unavailable())?;
        let discriminator = packet
            .get("method")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(AdapterError::sandbox_unavailable)?
            .to_owned();
        let packet = if matches!(discriminator.as_str(), "start" | "abort") {
            let roundtrip: PreparedControl =
                serde_json::from_value(packet).map_err(|_| AdapterError::sandbox_unavailable())?;
            serde_json::to_value(roundtrip).map_err(|_| AdapterError::sandbox_unavailable())?
        } else {
            let roundtrip: BrokerRequest =
                serde_json::from_value(packet).map_err(|_| AdapterError::sandbox_unavailable())?;
            serde_json::to_value(roundtrip).map_err(|_| AdapterError::sandbox_unavailable())?
        };
        let contract_message = contract
            .pointer(&format!("/messages/{discriminator}"))
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        validate_packet_against_contract(&packet, contract_message)?;
    }
    for packet in [
        serde_json::json!({"type":"prepared","job_id":job_id,"init_pid":7}),
        serde_json::json!({"type":"started","job_id":job_id,"init_pid":7}),
        serde_json::json!({"type":"aborted","job_id":job_id}),
        serde_json::json!({
            "type":"terminal",
            "job_id":job_id,
            "init_pid":7,
            "outcome":"completed",
            "artifacts":[]
        }),
        serde_json::json!({
            "type":"diagnostic",
            "correlation_id":correlation_id,
            "job_id":job_id,
            "phase":"prepared",
            "init_pid":7,
            "pidfd_live":true,
            "pidfd_pid_matches":true,
            "control_lease_connected":true,
            "inert_relay_fd_present":false,
            "relay_listener_present":false,
            "cdp_relay_opened":false,
            "payload_marker_present":false,
            "runc_state":"created",
            "cgroup_present":true,
            "job_directory_present":true,
            "child_count":1,
            "cleanup_failure":false
        }),
        serde_json::json!({"type":"error","category":"invalid","message":"rejected"}),
        serde_json::json!({"type":"owner_cancelled"}),
        serde_json::json!({"type":"healthy"}),
    ] {
        let parsed: BrokerResponse = serde_json::from_value(packet.clone())
            .map_err(|_| AdapterError::sandbox_unavailable())?;
        let packet =
            serde_json::to_value(parsed).map_err(|_| AdapterError::sandbox_unavailable())?;
        let discriminator = packet
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        let contract_message = contract
            .pointer(&format!("/messages/{discriminator}"))
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        validate_packet_against_contract(&packet, contract_message)?;
    }
    Ok(())
}

pub fn validate_installed_contract() -> Result<(), AdapterError> {
    validate_installed_contract_at(std::path::Path::new(INSTALLED_BROKER_CONTRACT_PATH), 0)
}

pub fn validate_installed_contract_at(
    path: &std::path::Path,
    expected_uid: u32,
) -> Result<(), AdapterError> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let metadata = file
        .metadata()
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    if !metadata.file_type().is_file()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o022 != 0
        || metadata.nlink() != 1
        || metadata.len() > MAX_BROKER_FRAME_BYTES as u64
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let mut content = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_BROKER_FRAME_BYTES as u64 + 1)
        .read_to_end(&mut content)
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    if content.len() > MAX_BROKER_FRAME_BYTES
        || content != BROKER_CONTRACT.as_bytes()
        || hex_sha256(&content) != BROKER_CONTRACT_SHA256
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    validate_shared_contract_bytes(&content)?;
    Ok(())
}

pub fn validate_shared_contract_bytes(raw: &[u8]) -> Result<serde_json::Value, AdapterError> {
    let contract: serde_json::Value =
        parse_json_strict(raw).map_err(|_| AdapterError::sandbox_unavailable())?;
    exact_value_keys(
        &contract,
        &["contractVersion", "messages", "phaseOrder", "transport"],
    )?;
    if contract
        .get("contractVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let transport = contract
        .get("transport")
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    exact_value_keys(
        transport,
        &[
            "encoding",
            "framing",
            "maxFrameBytes",
            "preparedControlLease",
        ],
    )?;
    if transport
        .get("encoding")
        .and_then(serde_json::Value::as_str)
        != Some("utf-8-json")
        || transport.get("framing").and_then(serde_json::Value::as_str) != Some("seqpacket")
        || transport
            .get("maxFrameBytes")
            .and_then(serde_json::Value::as_u64)
            != Some(MAX_BROKER_FRAME_BYTES as u64)
        || transport
            .get("preparedControlLease")
            .and_then(serde_json::Value::as_str)
            != Some("same-connection")
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let expected_phases = [
        "prepare",
        "prepared",
        "api_accepted",
        "api_authorized",
        "start",
        "started",
        "terminal",
    ];
    if contract
        .get("phaseOrder")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|phases| {
            phases
                != &expected_phases
                    .iter()
                    .map(|phase| serde_json::Value::String((*phase).to_owned()))
                    .collect::<Vec<_>>()
        })
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let messages = contract
        .get("messages")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    let expected_messages = [
        "abort",
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
        "terminal",
        "aborted",
    ];
    if messages.len() != expected_messages.len()
        || expected_messages
            .iter()
            .any(|message| !messages.contains_key(*message))
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    for (name, message) in messages {
        let has_bundle_table = name == "prepare";
        exact_value_keys(
            message,
            if has_bundle_table {
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
        let discriminator = message
            .get("discriminator")
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        exact_value_keys(discriminator, &["field", "value"])?;
        let expected_field = if matches!(
            name.as_str(),
            "prepare" | "start" | "abort" | "cancel" | "cancel_owner" | "diagnose" | "health"
        ) {
            "method"
        } else {
            "type"
        };
        if discriminator
            .get("field")
            .and_then(serde_json::Value::as_str)
            != Some(expected_field)
            || discriminator
                .get("value")
                .and_then(serde_json::Value::as_str)
                != Some(name)
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        let expected_direction = if expected_field == "method" {
            "adapter_to_broker"
        } else {
            "broker_to_adapter"
        };
        if message.get("direction").and_then(serde_json::Value::as_str) != Some(expected_direction)
        {
            return Err(AdapterError::sandbox_unavailable());
        }
        let fields = message
            .get("requiredFields")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(AdapterError::sandbox_unavailable)?;
        let names = fields
            .iter()
            .map(|field| {
                field
                    .as_str()
                    .filter(|field| !field.is_empty())
                    .ok_or_else(AdapterError::sandbox_unavailable)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if names.windows(2).any(|pair| pair[0] >= pair[1]) || !names.contains(&expected_field) {
            return Err(AdapterError::sandbox_unavailable());
        }
        let expected_fields: &[&str] = match name.as_str() {
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
            "owner_cancelled" | "health" | "healthy" => &[expected_field],
            "terminal" => &["artifacts", "init_pid", "job_id", "outcome", "type"],
            "error" => &["category", "message", "type"],
            _ => return Err(AdapterError::sandbox_unavailable()),
        };
        if names != expected_fields {
            return Err(AdapterError::sandbox_unavailable());
        }
        if has_bundle_table {
            let bundles = message
                .get("descriptorRolesByBundle")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(AdapterError::sandbox_unavailable)?;
            for bundle in ["codex-v1", "code-node-v1", "code-python-v1", "code-bash-v1"] {
                if !bundles.contains_key(bundle) {
                    return Err(AdapterError::sandbox_unavailable());
                }
            }
            if bundles.len() != 4 {
                return Err(AdapterError::sandbox_unavailable());
            }
            let expected_roles = [
                (
                    "codex-v1",
                    ["stdin", "stdout", "stderr", "auth", "config"].as_slice(),
                ),
                (
                    "code-node-v1",
                    ["input", "stdout", "stderr", "relay"].as_slice(),
                ),
                (
                    "code-python-v1",
                    ["input", "stdout", "stderr", "relay"].as_slice(),
                ),
                (
                    "code-bash-v1",
                    ["input", "stdout", "stderr", "relay"].as_slice(),
                ),
            ];
            for (bundle, expected) in expected_roles {
                if bundles
                    .get(bundle)
                    .and_then(serde_json::Value::as_array)
                    .is_none_or(|roles| {
                        roles
                            != &expected
                                .iter()
                                .map(|role| serde_json::Value::String((*role).to_owned()))
                                .collect::<Vec<_>>()
                    })
                {
                    return Err(AdapterError::sandbox_unavailable());
                }
            }
            for roles in bundles.values() {
                let roles = roles
                    .as_array()
                    .ok_or_else(AdapterError::sandbox_unavailable)?;
                if roles.is_empty()
                    || roles.iter().any(|role| {
                        role.as_str().is_none_or(|role| {
                            !matches!(
                                role,
                                "stdin"
                                    | "input"
                                    | "stdout"
                                    | "stderr"
                                    | "auth"
                                    | "config"
                                    | "relay"
                            )
                        })
                    })
                {
                    return Err(AdapterError::sandbox_unavailable());
                }
                let unique = roles
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<std::collections::BTreeSet<_>>();
                if unique.len() != roles.len() {
                    return Err(AdapterError::sandbox_unavailable());
                }
            }
        } else {
            let expected_roles: &[&str] = if name == "terminal" {
                &["artifacts"]
            } else {
                &[]
            };
            if message
                .get("descriptorRoles")
                .and_then(serde_json::Value::as_array)
                .is_none_or(|roles| {
                    roles
                        != &expected_roles
                            .iter()
                            .map(|role| serde_json::Value::String((*role).to_owned()))
                            .collect::<Vec<_>>()
                })
            {
                return Err(AdapterError::sandbox_unavailable());
            }
        }
    }
    Ok(contract)
}

fn exact_value_keys(value: &serde_json::Value, expected: &[&str]) -> Result<(), AdapterError> {
    let object = value
        .as_object()
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(AdapterError::sandbox_unavailable());
    }
    Ok(())
}

fn validate_packet_against_contract(
    packet: &serde_json::Value,
    message: &serde_json::Value,
) -> Result<(), AdapterError> {
    let packet = packet
        .as_object()
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    let required = message
        .get("requiredFields")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    if packet.len() != required.len()
        || required.iter().any(|field| {
            field
                .as_str()
                .is_none_or(|field| !packet.contains_key(field))
        })
    {
        return Err(AdapterError::sandbox_unavailable());
    }
    let field = message
        .pointer("/discriminator/field")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    let value = message
        .pointer("/discriminator/value")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    if packet.get(field).and_then(serde_json::Value::as_str) != Some(value) {
        return Err(AdapterError::sandbox_unavailable());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::IoSlice;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    use nix::sys::memfd::{MFdFlags, memfd_create};
    use nix::sys::socket::{
        AddressFamily, ControlMessage, MsgFlags, SockFlag, SockType, sendmsg, socketpair,
    };
    use serde_json::json;
    use uuid::Uuid;

    use super::{BrokerClient, CODEX_CONFIG};

    #[test]
    fn codex_config_disables_tool_surfaces() {
        for disabled in [
            "hooks = false",
            "mcp",
            "plugins = false",
            "shell_tool = false",
            "standalone_web_search = false",
        ] {
            assert!(CODEX_CONFIG.contains(disabled));
        }
    }

    #[test]
    fn production_wire_conforms_to_shared_contract() {
        super::validate_shared_contract().unwrap();
    }

    #[test]
    fn installed_contract_is_bound_to_exact_regular_bytes() {
        let root = std::env::temp_dir().join(format!("adapter-contract-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let contract = root.join("contract.json");
        fs::write(&contract, super::BROKER_CONTRACT).unwrap();
        fs::set_permissions(&contract, fs::Permissions::from_mode(0o600)).unwrap();
        let uid = fs::metadata(&contract).unwrap().uid();
        super::validate_installed_contract_at(&contract, uid).unwrap();

        fs::write(&contract, format!("{} ", super::BROKER_CONTRACT)).unwrap();
        assert!(super::validate_installed_contract_at(&contract, uid).is_err());
        fs::remove_file(&contract).unwrap();
        fs::write(root.join("target"), super::BROKER_CONTRACT).unwrap();
        symlink(root.join("target"), &contract).unwrap();
        assert!(super::validate_installed_contract_at(&contract, uid).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn count_memfd(name: &str) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter(|target| target.to_string_lossy().contains(name))
            .count()
    }

    #[test]
    fn every_response_with_descriptors_is_rejected_without_fd_leak() {
        let job_id = Uuid::new_v4();
        for response in [
            json!({"type":"prepared","job_id":job_id,"init_pid":7}),
            json!({"type":"started","job_id":job_id,"init_pid":7}),
            json!({"type":"aborted","job_id":job_id}),
            json!({
                "type":"terminal",
                "job_id":job_id,
                "init_pid":7,
                "outcome":"failed",
                "artifacts":[]
            }),
            json!({"type":"error","category":"invalid","message":"rejected"}),
        ] {
            let (receiver, sender) = socketpair(
                AddressFamily::Unix,
                SockType::SeqPacket,
                None,
                SockFlag::SOCK_CLOEXEC,
            )
            .unwrap();
            let name = format!("broker-response-fd-{}", Uuid::new_v4());
            let descriptor = memfd_create(name.as_str(), MFdFlags::MFD_CLOEXEC).unwrap();
            assert_eq!(count_memfd(&name), 1);
            let frame = serde_json::to_vec(&response).unwrap();
            let iov = [IoSlice::new(&frame)];
            let descriptors = [descriptor.as_raw_fd()];
            let control = [ControlMessage::ScmRights(&descriptors)];
            sendmsg::<()>(sender.as_raw_fd(), &iov, &control, MsgFlags::empty(), None).unwrap();
            let client = BrokerClient {
                socket_path: Default::default(),
            };
            assert!(client.receive_response(&receiver).is_err(), "{response}");
            assert_eq!(count_memfd(&name), 1, "{response}");
        }
    }

    #[test]
    fn truncated_payload_or_control_is_rejected_and_received_fds_close() {
        let client = BrokerClient {
            socket_path: Default::default(),
        };
        let (receiver, sender) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let oversized = vec![b'x'; super::MAX_BROKER_FRAME_BYTES + 2];
        sendmsg::<()>(
            sender.as_raw_fd(),
            &[IoSlice::new(&oversized)],
            &[],
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        assert!(client.receive_response(&receiver).is_err());

        let (receiver, sender) = socketpair(
            AddressFamily::Unix,
            SockType::SeqPacket,
            None,
            SockFlag::SOCK_CLOEXEC,
        )
        .unwrap();
        let name = format!("broker-response-cmsg-trunc-{}", Uuid::new_v4());
        let descriptor = memfd_create(name.as_str(), MFdFlags::MFD_CLOEXEC).unwrap();
        let descriptors = [descriptor.as_raw_fd(); 80];
        let control = [ControlMessage::ScmRights(&descriptors)];
        sendmsg::<()>(
            sender.as_raw_fd(),
            &[IoSlice::new(br#"{"type":"healthy"}"#)],
            &control,
            MsgFlags::empty(),
            None,
        )
        .unwrap();
        assert!(client.receive_response(&receiver).is_err());
        assert_eq!(count_memfd(&name), 1);
        assert!(super::validate_response_transport(MsgFlags::MSG_CTRUNC, false).is_err());
    }
}
