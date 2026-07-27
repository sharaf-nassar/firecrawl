#!/usr/bin/env python3
import importlib.metadata
import json
import pathlib
import signal
import socket
import struct
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

MAX_SOURCE_BYTES = 128 * 1024
MAX_ARTIFACTS = 8
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_TOTAL = 32 * 1024 * 1024
MAX_ARTIFACT_RESPONSE_BYTES = 4 * 1024
ARTIFACT_SOCKET_PATH = "/run/firecrawl-job/artifact.sock"
ENDPOINT_FILE = pathlib.Path("/run/firecrawl-job/cdp-endpoint")


def save_artifact(value):
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError("artifact_bytes_required")
    content = bytes(value)
    if not content or len(content) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact_limit_exceeded")
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(30)
    try:
        connection.connect(ARTIFACT_SOCKET_PATH)
        connection.sendall(struct.pack(">I", len(content)) + content)
        connection.shutdown(socket.SHUT_WR)
        response = b""
        while b"\n" not in response and len(response) <= MAX_ARTIFACT_RESPONSE_BYTES:
            chunk = connection.recv(4096)
            if not chunk:
                break
            response += chunk
    finally:
        connection.close()
    if (
        len(response) > MAX_ARTIFACT_RESPONSE_BYTES
        or not response.endswith(b"\n")
        or response.count(b"\n") != 1
    ):
        raise RuntimeError("artifact_response_invalid")
    parsed = json.loads(response)
    if parsed.get("ok") is not True:
        raise RuntimeError(parsed.get("error", "artifact_request_failed"))
    if (
        set(parsed) != {"ok", "kind", "byteSize"}
        or parsed["kind"] not in ("screenshot", "trace", "recording")
        or parsed["byteSize"] != len(content)
    ):
        raise RuntimeError("artifact_response_invalid")
    return {"kind": parsed["kind"], "byteSize": parsed["byteSize"]}


def read_source():
    source = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
    if len(source) > MAX_SOURCE_BYTES:
        raise ValueError("source_too_large")
    return source.decode("utf-8", "strict")


def wait_for_endpoint(process):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("cdp_relay_failed")
        try:
            endpoint = ENDPOINT_FILE.read_text(encoding="utf-8")
            if endpoint.endswith("\n") and endpoint.count("\n") == 1:
                return endpoint[:-1]
        except FileNotFoundError:
            pass
        time.sleep(0.01)
    raise TimeoutError("cdp_relay_timeout")


def main():
    if len(sys.argv) != 1:
        raise ValueError("invalid_runner_invocation")
    if importlib.metadata.version("playwright") != "1.61.0":
        raise RuntimeError("playwright_version_mismatch")
    source = read_source()
    relay = subprocess.Popen(
        ["/usr/local/bin/node", "/opt/firecrawl/bin/cdp-relay.mjs", "--serve"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=sys.stderr,
        close_fds=True,
    )
    try:
        endpoint = wait_for_endpoint(relay)
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(endpoint, timeout=30_000)
            try:
                contexts = browser.contexts
                if len(contexts) != 1 or len(contexts[0].pages) != 1:
                    raise RuntimeError("relay_target_mismatch")
                context = contexts[0]
                page = context.pages[0]
                scope = {
                    "__builtins__": __builtins__,
                    "page": page,
                    "context": context,
                    "browser": browser,
                    "save_artifact": save_artifact,
                }
                exec(compile(source, "<firecrawl-code>", "exec"), scope, scope)
            finally:
                browser.close()
    finally:
        relay.send_signal(signal.SIGTERM)
        try:
            relay.wait(timeout=2)
        except subprocess.TimeoutExpired:
            relay.kill()
            relay.wait(timeout=2)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) or "code_execution_failed", file=sys.stderr)
        raise SystemExit(1)
