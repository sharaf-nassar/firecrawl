use std::collections::BTreeMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use zeroize::{Zeroize, Zeroizing};

use crate::redaction::AdapterError;

pub const DEFAULT_PROTOCOL_ROOT: &str = "/opt/firecrawl/protocol/codex-app-server";
pub const MAX_PROMPT_RUNS: usize = 1;
pub const MAX_CODE_RUNS: usize = 2;

const ADAPTER_SOCKET: &str = "FIRECRAWL_ADAPTER_SOCKET";
const BROKER_SOCKET: &str = "FIRECRAWL_BROKER_SOCKET";
const CALLBACK_URL: &str = "FIRECRAWL_CALLBACK_URL";
const CALLBACK_TOKEN_FILE: &str = "FIRECRAWL_CALLBACK_TOKEN_FILE";
const CODEX_AUTH_FILE: &str = "FIRECRAWL_CODEX_AUTH_FILE";
const PROMPT_RUNS: &str = "FIRECRAWL_MAX_PROMPT_RUNS";
const CODE_RUNS: &str = "FIRECRAWL_MAX_CODE_RUNS";

const ALLOWED_FIRECRAWL_ENVIRONMENT: [&str; 7] = [
    ADAPTER_SOCKET,
    BROKER_SOCKET,
    CALLBACK_URL,
    CALLBACK_TOKEN_FILE,
    CODEX_AUTH_FILE,
    PROMPT_RUNS,
    CODE_RUNS,
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterConfig {
    pub adapter_socket: PathBuf,
    pub broker_socket: PathBuf,
    pub callback_url: String,
    pub callback_token_file: PathBuf,
    pub codex_auth_file: PathBuf,
    pub protocol_root: PathBuf,
    pub max_prompt_runs: usize,
    pub max_code_runs: usize,
}

impl AdapterConfig {
    pub fn from_environment() -> Result<Self, AdapterError> {
        Self::from_entries(env::vars_os())
    }

    pub fn from_entries<I, K, V>(entries: I) -> Result<Self, AdapterError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        let mut values = BTreeMap::new();
        for (key, value) in entries {
            let key = key.into();
            if key.to_string_lossy().starts_with("FIRECRAWL_")
                && !ALLOWED_FIRECRAWL_ENVIRONMENT
                    .iter()
                    .any(|allowed| key == OsStr::new(allowed))
            {
                return Err(AdapterError::model_protocol());
            }
            values.insert(key, value.into());
        }
        let required = |name: &str| -> Result<String, AdapterError> {
            values
                .get(OsStr::new(name))
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(AdapterError::model_protocol)
        };
        let adapter_socket = absolute_path(&required(ADAPTER_SOCKET)?)?;
        let broker_socket = absolute_path(&required(BROKER_SOCKET)?)?;
        let callback_token_file = absolute_path(&required(CALLBACK_TOKEN_FILE)?)?;
        let codex_auth_file = absolute_path(&required(CODEX_AUTH_FILE)?)?;
        let callback_url = required(CALLBACK_URL)?;
        if !valid_loopback_http_origin(&callback_url) {
            return Err(AdapterError::model_protocol());
        }
        let max_prompt_runs = exact_usize(&required(PROMPT_RUNS)?, MAX_PROMPT_RUNS)?;
        let max_code_runs = exact_usize(&required(CODE_RUNS)?, MAX_CODE_RUNS)?;
        Ok(Self {
            adapter_socket,
            broker_socket,
            callback_url,
            callback_token_file,
            codex_auth_file,
            protocol_root: PathBuf::from(DEFAULT_PROTOCOL_ROOT),
            max_prompt_runs,
            max_code_runs,
        })
    }

    pub fn read_callback_token(&self) -> Result<Zeroizing<String>, AdapterError> {
        let raw = read_private_file(&self.callback_token_file, 4_096)
            .map_err(|_| AdapterError::capability_denied())?;
        let mut token = std::str::from_utf8(&raw)
            .map_err(|_| AdapterError::capability_denied())?
            .trim()
            .to_owned();
        if !(32..=4_096).contains(&token.len()) || token.chars().any(char::is_whitespace) {
            token.zeroize();
            return Err(AdapterError::capability_denied());
        }
        Ok(Zeroizing::new(token))
    }

    pub fn boot_id_file(&self) -> PathBuf {
        self.adapter_socket.with_file_name("adapter.boot-id")
    }
}

fn absolute_path(value: &str) -> Result<PathBuf, AdapterError> {
    let path = Path::new(value);
    let normalized = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    let rebuilt = format!("/{}", normalized.join("/"));
    if !path.is_absolute()
        || normalized.is_empty()
        || rebuilt != value
        || path.components().any(|component| {
            !matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
    {
        return Err(AdapterError::model_protocol());
    }
    Ok(path.to_path_buf())
}

pub(crate) fn read_private_file(
    path: &Path,
    maximum_bytes: usize,
) -> Result<Zeroizing<Vec<u8>>, ()> {
    if maximum_bytes == 0 {
        return Err(());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file()
        || metadata.uid() != effective_uid().map_err(|_| ())?
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.len() == 0
        || metadata.len() > maximum_bytes as u64
    {
        return Err(());
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
    file.take(maximum_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(());
    }
    Ok(bytes)
}

pub(crate) fn effective_uid() -> Result<u32, AdapterError> {
    let status = std::fs::read_to_string("/proc/self/status")
        .map_err(|_| AdapterError::sandbox_unavailable())?;
    let line = status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .ok_or_else(AdapterError::sandbox_unavailable)?;
    line.split_ascii_whitespace()
        .nth(2)
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(AdapterError::sandbox_unavailable)
}

fn exact_usize(value: &str, expected: usize) -> Result<usize, AdapterError> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| AdapterError::model_protocol())?;
    if parsed != expected {
        return Err(AdapterError::model_protocol());
    }
    Ok(parsed)
}

fn valid_loopback_http_origin(value: &str) -> bool {
    let Some(authority) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    !authority.is_empty()
        && authority.bytes().all(|byte| byte.is_ascii_digit())
        && authority.parse::<u16>().is_ok_and(|port| port != 0)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use uuid::Uuid;

    use super::{absolute_path, read_private_file};

    fn temporary_root() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("firecrawl-adapter-config-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn absolute_paths_are_lexically_canonical() {
        assert!(absolute_path("/run/firecrawl/adapter.sock").is_ok());
        for invalid in [
            "run/firecrawl/adapter.sock",
            "/",
            "//run/firecrawl/adapter.sock",
            "/run//firecrawl/adapter.sock",
            "/run/./firecrawl/adapter.sock",
            "/run/firecrawl/../adapter.sock",
            "/run/firecrawl/adapter.sock/",
        ] {
            assert!(absolute_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn private_files_reject_symlinks_and_non_private_modes() {
        let root = temporary_root();
        let target = root.join("target");
        fs::write(&target, b"secret").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(&*read_private_file(&target, 32).unwrap(), b"secret");

        let link = root.join("link");
        symlink(&target, &link).unwrap();
        assert!(read_private_file(&link, 32).is_err());

        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_private_file(&target, 32).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
