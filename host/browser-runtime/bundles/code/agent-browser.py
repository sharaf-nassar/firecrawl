#!/usr/bin/env python3
import importlib.metadata
import json
import os
import pathlib
import signal
import socket
import struct
import sys
import time

from playwright.sync_api import sync_playwright

SOCKET_PATH = pathlib.Path("/run/firecrawl-job/agent-browser.sock")
ENDPOINT_FILE = pathlib.Path("/run/firecrawl-job/cdp-endpoint")
ARTIFACT_SOCKET_PATH = "/run/firecrawl-job/artifact.sock"
MAX_COMMAND_BYTES = 64 * 1024
MAX_ARTIFACT_RESPONSE_BYTES = 4 * 1024
MAX_ARTIFACTS = 8
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_TOTAL = 32 * 1024 * 1024


def exact_endpoint():
    raw = ENDPOINT_FILE.read_text(encoding="utf-8")
    if not raw.endswith("\n") or raw.count("\n") != 1:
        raise RuntimeError("invalid_cdp_endpoint")
    return raw[:-1]


def save_artifact(content):
    if not isinstance(content, bytes) or not content or len(content) > MAX_ARTIFACT_BYTES:
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


def dispatch(page, command, arguments):
    if command == "snapshot" and not arguments:
        return page.content()
    if command == "click" and len(arguments) == 1:
        page.locator(arguments[0]).click()
        return None
    if command == "fill" and len(arguments) == 2:
        page.locator(arguments[0]).fill(arguments[1])
        return None
    if command == "type" and len(arguments) == 2:
        page.locator(arguments[0]).press_sequentially(arguments[1])
        return None
    if command == "press" and len(arguments) == 2:
        page.locator(arguments[0]).press(arguments[1])
        return None
    if command == "select" and len(arguments) >= 2 and len(arguments) <= 21:
        return page.locator(arguments[0]).select_option(arguments[1:])
    if command == "scroll" and len(arguments) == 2:
        page.mouse.wheel(float(arguments[0]), float(arguments[1]))
        return None
    if command == "wait" and len(arguments) == 1:
        milliseconds = int(arguments[0])
        if milliseconds < 0 or milliseconds > 30_000:
            raise ValueError("invalid_wait")
        page.wait_for_timeout(milliseconds)
        return None
    if command == "get-text" and len(arguments) in (0, 1):
        return (
            page.locator(arguments[0]).text_content()
            if arguments
            else page.locator("body").text_content()
        )
    if command == "get-url" and not arguments:
        return page.url
    if command == "navigate" and len(arguments) == 1:
        page.goto(arguments[0])
        return page.url
    if command == "evaluate" and len(arguments) == 1:
        return page.evaluate(arguments[0])
    if command == "screenshot" and not arguments:
        return save_artifact(page.screenshot(type="png"))
    raise ValueError("command_rejected")


def server():
    if importlib.metadata.version("playwright") != "1.61.0":
        raise RuntimeError("playwright_version_mismatch")
    stop = False

    def request_stop(_signal, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(exact_endpoint(), timeout=30_000)
        try:
            if len(browser.contexts) != 1 or len(browser.contexts[0].pages) != 1:
                raise RuntimeError("relay_target_mismatch")
            page = browser.contexts[0].pages[0]
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                listener.bind(str(SOCKET_PATH))
                os.chmod(SOCKET_PATH, 0o600)
                listener.listen(4)
                listener.settimeout(0.1)
                while not stop:
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    with connection:
                        raw = b""
                        while b"\n" not in raw and len(raw) <= MAX_COMMAND_BYTES:
                            chunk = connection.recv(4096)
                            if not chunk:
                                break
                            raw += chunk
                        try:
                            if (
                                len(raw) > MAX_COMMAND_BYTES
                                or not raw.endswith(b"\n")
                                or raw.count(b"\n") != 1
                            ):
                                raise ValueError("invalid_command")
                            request = json.loads(raw)
                            if (
                                type(request) is not dict
                                or set(request) != {"version", "command", "arguments"}
                                or request["version"] != 1
                                or type(request["command"]) is not str
                                or type(request["arguments"]) is not list
                                or any(type(value) is not str for value in request["arguments"])
                            ):
                                raise ValueError("invalid_command")
                            result = dispatch(
                                page, request["command"], request["arguments"]
                            )
                            response = {"ok": True, "result": result}
                        except Exception:
                            response = {"ok": False, "error": "command_failed"}
                        connection.sendall(
                            (json.dumps(response, separators=(",", ":")) + "\n").encode()
                        )
            finally:
                listener.close()
                SOCKET_PATH.unlink(missing_ok=True)
        finally:
            browser.close()


def client(command, arguments):
    request = {
        "version": 1,
        "command": command,
        "arguments": arguments,
    }
    raw = (json.dumps(request, separators=(",", ":")) + "\n").encode()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(30)
    try:
        connection.connect(str(SOCKET_PATH))
        connection.sendall(raw)
        response = b""
        while b"\n" not in response and len(response) <= MAX_COMMAND_BYTES:
            chunk = connection.recv(4096)
            if not chunk:
                break
            response += chunk
    finally:
        connection.close()
    parsed = json.loads(response)
    if set(parsed) == {"ok", "error"} and parsed["ok"] is False:
        raise RuntimeError(parsed["error"])
    if set(parsed) != {"ok", "result"} or parsed["ok"] is not True:
        raise RuntimeError("invalid_agent_response")
    result = parsed["result"]
    if result is not None:
        print(result if isinstance(result, str) else json.dumps(result, separators=(",", ":")))


def main():
    if sys.argv[1:] == ["--server"]:
        server()
        return
    if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
        raise ValueError("invalid_agent_browser_invocation")
    client(sys.argv[1], sys.argv[2:])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) or "agent_browser_failed", file=sys.stderr)
        raise SystemExit(1)
