use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::decision::{Effect, canonical_operation_hash, classify};
use crate::observations::{BrowserOperationKind, ObservationV1};
use crate::protocol::{BrowserOperation, ModelDecisionV1, VersionOne};
use crate::redaction::AdapterError;

const MAX_CALLBACK_BYTES: usize = 65_536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdapterAuthorizationBinding {
    pub adapter_job_id: Uuid,
    pub adapter_supervisor_id: Uuid,
    pub adapter_process_id: u32,
}

impl AdapterAuthorizationBinding {
    pub fn new(
        adapter_job_id: Uuid,
        adapter_supervisor_id: Uuid,
        adapter_process_id: u32,
    ) -> Result<Self, AdapterError> {
        if adapter_job_id.is_nil() || adapter_supervisor_id.is_nil() || adapter_process_id == 0 {
            return Err(AdapterError::model_protocol());
        }
        Ok(Self {
            adapter_job_id,
            adapter_supervisor_id,
            adapter_process_id,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SubmitBrowserActionV1 {
    version: VersionOne,
    adapter_job_id: Uuid,
    sequence: u8,
    action_id: Uuid,
    proposal_hash: String,
    effect: Effect,
    operation: BrowserOperation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CallbackError {
    success: bool,
    error: String,
    message: String,
}

pub struct ActionClient {
    client: Client,
    callback_origin: String,
    callback_token: Zeroizing<String>,
    binding: AdapterAuthorizationBinding,
    run_id: Uuid,
}

impl ActionClient {
    pub fn new(
        callback_origin: String,
        callback_token: Zeroizing<String>,
        binding: AdapterAuthorizationBinding,
        run_id: Uuid,
    ) -> Result<Self, AdapterError> {
        if run_id.is_nil()
            || !valid_loopback_origin(&callback_origin)
            || !(32..=4_096).contains(&callback_token.len())
            || callback_token.chars().any(char::is_whitespace)
        {
            return Err(AdapterError::capability_denied());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AdapterError::action_outcome_unknown())?;
        Ok(Self {
            client,
            callback_origin,
            callback_token,
            binding,
            run_id,
        })
    }

    pub async fn execute(
        &self,
        sequence: u8,
        operation: BrowserOperation,
        timeout: Duration,
    ) -> Result<ObservationV1, AdapterError> {
        if !(1..=25).contains(&sequence) || timeout.is_zero() {
            return Err(AdapterError::model_protocol());
        }
        let action_id = Uuid::new_v4();
        let expected_action_kind = BrowserOperationKind::for_operation(&operation);
        let decision = ModelDecisionV1::Action {
            version: VersionOne,
            action: operation.clone(),
        };
        let proposal = SubmitBrowserActionV1 {
            version: VersionOne,
            adapter_job_id: self.binding.adapter_job_id,
            sequence,
            action_id,
            proposal_hash: canonical_operation_hash(&operation)
                .map_err(|_| AdapterError::model_protocol())?,
            effect: classify(&decision),
            operation,
        };
        let proposal_body =
            serde_json::to_vec(&proposal).map_err(|_| AdapterError::model_protocol())?;
        let endpoint = format!(
            "{}/internal/browser-runs/{}/actions",
            self.callback_origin, self.run_id
        );
        let deadline = Instant::now() + timeout;
        let mut transport_attempt = 0_u8;
        'attempts: loop {
            transport_attempt += 1;
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(AdapterError::timed_out)?;
            let request = self
                .client
                .post(&endpoint)
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
                .header("content-type", "application/json")
                .body(proposal_body.clone());
            let mut response = match request.send().await {
                Ok(response) => response,
                Err(error) if error.is_timeout() => return Err(AdapterError::timed_out()),
                Err(_) if transport_attempt == 1 => continue,
                Err(_) => return Err(AdapterError::action_outcome_unknown()),
            };
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > MAX_CALLBACK_BYTES as u64)
            {
                return Err(AdapterError::action_outcome_unknown());
            }
            let mut bytes = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if bytes
                            .len()
                            .checked_add(chunk.len())
                            .is_none_or(|length| length > MAX_CALLBACK_BYTES)
                        {
                            return Err(AdapterError::action_outcome_unknown());
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(error) if error.is_timeout() => return Err(AdapterError::timed_out()),
                    Err(_) if transport_attempt == 1 => continue 'attempts,
                    Err(_) => return Err(AdapterError::action_outcome_unknown()),
                }
            }
            if status == StatusCode::OK {
                let observation: ObservationV1 = serde_json::from_slice(&bytes)
                    .map_err(|_| AdapterError::action_outcome_unknown())?;
                observation
                    .validate()
                    .map_err(|_| AdapterError::action_outcome_unknown())?;
                match &observation {
                    ObservationV1::ActionResult {
                        sequence: observed_sequence,
                        action_id: observed_action_id,
                        action_kind,
                        ..
                    } if *observed_sequence == sequence
                        && observed_action_id == &action_id.to_string()
                        && *action_kind == expected_action_kind =>
                    {
                        return Ok(observation);
                    }
                    _ => return Err(AdapterError::action_outcome_unknown()),
                }
            }
            return Err(map_callback_error(status, &bytes));
        }
    }
}

fn map_callback_error(status: StatusCode, bytes: &[u8]) -> AdapterError {
    let Ok(error) = serde_json::from_slice::<CallbackError>(bytes) else {
        return AdapterError::action_outcome_unknown();
    };
    if error.success || error.error.is_empty() || error.message.is_empty() {
        return AdapterError::action_outcome_unknown();
    }
    match error.error.as_str() {
        "capability_denied" if status == StatusCode::FORBIDDEN => AdapterError::capability_denied(),
        "action_outcome_unknown" => AdapterError::action_outcome_unknown(),
        "cancelled" => AdapterError::cancelled(),
        "deadline_exceeded" => AdapterError::timed_out(),
        _ => AdapterError::action_outcome_unknown(),
    }
}

fn valid_loopback_origin(value: &str) -> bool {
    let Some(port) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    port.parse::<u16>().is_ok_and(|port| port != 0)
}

#[cfg(test)]
mod tests {
    use crate::decision::canonical_operation_hash;
    use crate::protocol::{BrowserOperation, ElementRef};

    #[test]
    fn operation_hash_is_stable() {
        let operation = BrowserOperation::Click {
            r#ref: ElementRef::new("@e7".to_owned()).unwrap(),
        };
        assert_eq!(canonical_operation_hash(&operation).unwrap().len(), 64);
        assert_eq!(
            canonical_operation_hash(&operation).unwrap(),
            canonical_operation_hash(&operation).unwrap()
        );
    }
}
