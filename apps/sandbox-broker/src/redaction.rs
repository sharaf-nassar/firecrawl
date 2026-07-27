use std::fmt;
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCategory {
    InvalidRequest,
    Unauthorized,
    Conflict,
    DeadlineExceeded,
    SandboxUnavailable,
    CleanupFailed,
}

impl ErrorCategory {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Unauthorized => "unauthorized",
            Self::Conflict => "conflict",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::SandboxUnavailable => "sandbox_unavailable",
            Self::CleanupFailed => "cleanup_failed",
        }
    }
}

#[derive(Debug)]
pub struct BrokerError {
    category: ErrorCategory,
    source: Option<anyhow::Error>,
}

impl BrokerError {
    pub fn new(category: ErrorCategory) -> Self {
        Self {
            category,
            source: None,
        }
    }

    pub fn with_source(category: ErrorCategory, source: impl Into<anyhow::Error>) -> Self {
        Self {
            category,
            source: Some(source.into()),
        }
    }

    pub const fn category(&self) -> ErrorCategory {
        self.category
    }

    pub const fn public_message(&self) -> &'static str {
        match self.category {
            ErrorCategory::InvalidRequest => "request rejected",
            ErrorCategory::Unauthorized => "peer rejected",
            ErrorCategory::Conflict => "job state rejected",
            ErrorCategory::DeadlineExceeded => "deadline exceeded",
            ErrorCategory::SandboxUnavailable => "sandbox unavailable",
            ErrorCategory::CleanupFailed => "sandbox cleanup failed",
        }
    }
}

impl fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.public_message())
    }
}

impl std::error::Error for BrokerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source.as_ref() as &(dyn std::error::Error + 'static))
    }
}

impl From<io::Error> for BrokerError {
    fn from(error: io::Error) -> Self {
        Self::with_source(ErrorCategory::SandboxUnavailable, error)
    }
}

pub type BrokerResult<T> = Result<T, BrokerError>;
