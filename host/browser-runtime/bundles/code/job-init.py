#!/usr/bin/env python3
import os
import signal
import stat
import subprocess
import sys
import time

SUPERVISOR = "/opt/firecrawl/bin/job-relay-supervisor.mjs"
RUNNERS = {
    "/opt/firecrawl/bin/run-node.mjs",
    "/opt/firecrawl/bin/run-python.py",
    "/opt/firecrawl/bin/run-bash.sh",
}
KILL_GRACE_SECONDS = 2


def payload_pids():
    output = []
    for entry in os.listdir("/proc"):
        if entry.isascii() and entry.isdigit():
            pid = int(entry)
            if pid > 1:
                output.append(pid)
    return sorted(output)


def signal_pids(pids, requested_signal):
    for pid in pids:
        try:
            os.kill(pid, requested_signal)
        except ProcessLookupError:
            pass


def reap_nonblocking():
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def drain_payloads(requested_signal):
    deadline = time.monotonic() + KILL_GRACE_SECONDS
    while True:
        reap_nonblocking()
        pids = payload_pids()
        if not pids:
            return True
        signal_pids(pids, requested_signal)
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.02)


def terminate_payloads():
    if drain_payloads(signal.SIGTERM):
        return
    if not drain_payloads(signal.SIGKILL):
        raise RuntimeError("job_init_payload_survived")


def exit_code(status):
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 + (-code)


def validate_executable(path):
    metadata = os.lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o555
    ):
        raise RuntimeError("job_init_executable_invalid")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in RUNNERS:
        raise ValueError("invalid_job_init_invocation")
    if os.getpid() != 1:
        raise RuntimeError("job_init_not_pid1")
    if not stat.S_ISSOCK(os.fstat(3).st_mode):
        raise RuntimeError("relay_descriptor_invalid")
    validate_executable(SUPERVISOR)
    validate_executable(sys.argv[1])
    os.set_inheritable(3, True)
    supervisor = subprocess.Popen(
        [SUPERVISOR, sys.argv[1]],
        close_fds=True,
        pass_fds=(3,),
    )
    supervisor_status = None

    def forward(requested_signal, _frame):
        if supervisor_status is None:
            try:
                os.kill(supervisor.pid, requested_signal)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    while supervisor_status is None:
        try:
            pid, status = os.wait()
        except InterruptedError:
            continue
        if pid == supervisor.pid:
            supervisor_status = status
    supervisor.returncode = exit_code(supervisor_status)
    terminate_payloads()
    if payload_pids():
        raise RuntimeError("job_init_payload_survived")
    return supervisor.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error) or "job_init_failed", file=sys.stderr)
        raise SystemExit(1)
