use std::error::Error;
use std::fmt;

use serde::{Deserialize, Serialize};

const MAX_PUBLIC_MESSAGE_CHARACTERS: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterErrorCategory {
    CodexUnavailable,
    SandboxUnavailable,
    Cancelled,
    TimedOut,
    ModelProtocolError,
    ActionOutcomeUnknown,
    CapabilityDenied,
    NotFound,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterError {
    pub category: AdapterErrorCategory,
    pub message: String,
}

impl AdapterError {
    pub fn new(category: AdapterErrorCategory, message: &'static str) -> Self {
        debug_assert!(message.chars().count() <= MAX_PUBLIC_MESSAGE_CHARACTERS);
        Self {
            category,
            message: message.to_owned(),
        }
    }

    pub fn codex_unavailable() -> Self {
        Self::new(
            AdapterErrorCategory::CodexUnavailable,
            "Codex execution is unavailable",
        )
    }

    pub fn sandbox_unavailable() -> Self {
        Self::new(
            AdapterErrorCategory::SandboxUnavailable,
            "Sandbox execution is unavailable",
        )
    }

    pub fn cancelled() -> Self {
        Self::new(AdapterErrorCategory::Cancelled, "Execution was cancelled")
    }

    pub fn timed_out() -> Self {
        Self::new(AdapterErrorCategory::TimedOut, "Execution timed out")
    }

    pub fn model_protocol() -> Self {
        Self::new(
            AdapterErrorCategory::ModelProtocolError,
            "Codex returned an invalid protocol response",
        )
    }

    pub fn action_outcome_unknown() -> Self {
        Self::new(
            AdapterErrorCategory::ActionOutcomeUnknown,
            "Browser action outcome is unknown",
        )
    }

    pub fn capability_denied() -> Self {
        Self::new(
            AdapterErrorCategory::CapabilityDenied,
            "Browser capability was denied",
        )
    }

    pub fn not_found() -> Self {
        Self::new(AdapterErrorCategory::NotFound, "Host job was not found")
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let category = serde_json::to_value(self.category)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "adapter_error".to_owned());
        formatter.write_str(&category)
    }
}

impl Error for AdapterError {}

pub fn sanitize_error_message(input: &str) -> String {
    input
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_PUBLIC_MESSAGE_CHARACTERS)
        .collect()
}
