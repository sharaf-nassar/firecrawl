#!/usr/bin/env python3

import argparse
import json
import os
import re
import stat
import tempfile
import tomllib
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

MAX_CONFIG_BYTES = 1024 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
PROVIDER_KEYS = {
    "base_url",
    "env_http_headers",
    "env_key",
    "env_key_instructions",
    "experimental_bearer_token",
    "http_headers",
    "name",
    "query_params",
    "request_max_retries",
    "requires_openai_auth",
    "stream_idle_timeout_ms",
    "stream_max_retries",
    "supports_standalone_web_search",
    "supports_websockets",
    "websocket_connect_timeout_ms",
    "wire_api",
}
UNSIGNED_INTEGER_PROVIDER_KEYS = {
    "request_max_retries",
    "stream_idle_timeout_ms",
    "stream_max_retries",
    "websocket_connect_timeout_ms",
}
RESERVED_ENV_NAMES = {
    "HOME",
    "PATH",
    "SHELL",
    "TMP",
    "TEMP",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
}
RESERVED_ENV_PREFIXES = ("CODEX_", "DYLD_", "LD_", "NODE_", "RUST_")


def fail(message):
    raise SystemExit(f"Local Codex provider config is unsafe: {message}")


def read_config(path):
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        fail(f"cannot open ~/.codex/config.toml ({error.strerror})")
    try:
        status = os.fstat(descriptor)
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_uid != os.getuid()
            or status.st_nlink != 1
            or stat.S_IMODE(status.st_mode) not in {0o400, 0o600}
            or status.st_size <= 0
            or status.st_size > MAX_CONFIG_BYTES
        ):
            fail("~/.codex/config.toml must be an owned 0400/0600 bounded regular file")
        source = os.read(descriptor, MAX_CONFIG_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        return tomllib.loads(source.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        fail("~/.codex/config.toml is not valid UTF-8 TOML")


def toml_key(value):
    return json.dumps(value, ensure_ascii=False)


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(
            f"{toml_key(key)} = {toml_value(item)}"
            for key, item in value.items()
        ) + " }"
    fail("selected provider contains an unsupported value type")


def checked_environment_name(value):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 128
        or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", value) is None
        or value in RESERVED_ENV_NAMES
        or value.startswith(RESERVED_ENV_PREFIXES)
    ):
        fail("selected provider names an unsafe environment variable")
    return value


def provider_environment(provider):
    names = []
    if provider.get("requires_openai_auth") is not True and "env_key" in provider:
        names.append((checked_environment_name(provider["env_key"]), True))
    headers = provider.get("env_http_headers", {})
    if not isinstance(headers, dict) or not all(
        isinstance(header, str) and isinstance(name, str)
        for header, name in headers.items()
    ):
        fail("selected provider has invalid env_http_headers")
    names.extend(
        (checked_environment_name(name), False) for name in headers.values()
    )
    result = {}
    for name, required in names:
        if name in result:
            continue
        value = os.environ.get(name)
        if value is None:
            if required:
                fail(f"selected provider requires environment variable {name}")
            continue
        if not value and not required:
            continue
        if len(value.encode("utf-8")) > 64 * 1024:
            fail(f"selected provider environment variable {name} is too large")
        result[name] = value
    return result


def validate_provider_types(provider):
    for key in UNSIGNED_INTEGER_PROVIDER_KEYS:
        if key in provider and (
            type(provider[key]) is not int or provider[key] < 0
        ):
            fail(f"selected provider has invalid {key}")


def routed_base_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        fail("selected provider base_url is missing or invalid")
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        fail("selected provider base_url cannot contain credentials, query, or fragment")
    try:
        port = parsed.port
    except ValueError:
        fail("selected provider base_url has an invalid port")
    hostname = parsed.hostname
    if hostname in LOOPBACK_HOSTS:
        if parsed.scheme != "http":
            fail("loopback provider base_url must use http")
        port = port or 80
        rewritten = urlunsplit(
            ("http", f"host.docker.internal:{port}", parsed.path, "", "")
        )
        return rewritten, {"httpHost": "host.docker.internal", "httpPort": port}
    if parsed.scheme != "https" or port not in {None, 443} or hostname is None:
        fail("non-loopback provider base_url must use https port 443")
    return value, {"httpsHost": hostname.lower()}


def atomic_write(path, content):
    destination = Path(path)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--config-output", required=True)
    parser.add_argument("--environment-output", required=True)
    parser.add_argument("--egress-output", required=True)
    args = parser.parse_args()

    source = read_config(args.source)
    model = source.get("model")
    provider_id = source.get("model_provider", "openai")
    if not isinstance(model, str) or not model or len(model) > 256:
        fail("top-level model must be a nonempty string")
    if not isinstance(provider_id, str) or not provider_id or len(provider_id) > 128:
        fail("top-level model_provider must be a nonempty string")

    provider = {}
    config = {"model": model, "model_provider": provider_id}
    egress = {}
    if provider_id == "openai":
        if "openai_base_url" in source:
            base_url, egress = routed_base_url(source["openai_base_url"])
            config["openai_base_url"] = base_url
    else:
        providers = source.get("model_providers")
        provider = providers.get(provider_id) if isinstance(providers, dict) else None
        if not isinstance(provider, dict):
            fail("selected model_provider has no matching provider table")
        unsupported = sorted(set(provider) - PROVIDER_KEYS)
        if unsupported:
            fail(f"selected provider uses unsupported field {unsupported[0]}")
        provider = dict(provider)
        validate_provider_types(provider)
        provider["base_url"], egress = routed_base_url(provider.get("base_url"))
        config["model_providers"] = {provider_id: provider}

    lines = [f"{key} = {toml_value(value)}" for key, value in config.items()]
    atomic_write(args.config_output, ("\n".join(lines) + "\n").encode())
    atomic_write(
        args.environment_output,
        (json.dumps(provider_environment(provider), separators=(",", ":")) + "\n").encode(),
    )
    atomic_write(
        args.egress_output,
        (json.dumps(egress, separators=(",", ":")) + "\n").encode(),
    )


if __name__ == "__main__":
    main()
