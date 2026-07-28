#!/usr/bin/python3

import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime
from pathlib import Path

SHA256 = re.compile(r"^[0-9a-f]{64}$")
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
TIMESTAMP = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$"
)
CODE_RUNTIME = {
    "node": "22.22.1",
    "python": "3.12.3",
    "bash": "5.2.21",
    "javascriptPlaywright": "1.61.1",
    "pythonPlaywright": "1.61.0",
    "relayProtocol": "code-relay-v1",
}
SCHEMA_LOGICAL_PREFIX = "host/browser-runtime/protocol/codex-app-server/"
BROKER_CONTRACT_SHA256 = (
    "709ed34abc51ca9a9b44d96e1496667ac535ea8ff53d372d10817f4b613c48a1"
)


def fail(code: str) -> None:
    raise RuntimeError(code)


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(65536):
            value.update(block)
    return value.hexdigest()


class JsonNumber(str):
    pass


def canonical_json(raw: bytes) -> bytes:
    if raw.startswith(b"\xef\xbb\xbf"):
        fail("generation_json_identity")
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("generation_json_identity")

    def object_pairs(pairs):
        output = {}
        for key, value in pairs:
            if key in output:
                fail("generation_json_identity")
            output[key] = value
        return output

    try:
        value = json.loads(
            text,
            parse_int=JsonNumber,
            parse_float=JsonNumber,
            parse_constant=lambda _: fail("generation_json_identity"),
            object_pairs_hook=object_pairs,
        )
    except (json.JSONDecodeError, UnicodeDecodeError):
        fail("generation_json_identity")

    def string(value: str) -> str:
        output = ['"']
        escapes = {
            "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f",
            "\r": "\\r", '"': '\\"', "\\": "\\\\",
        }
        for character in value:
            code = ord(character)
            if 0xD800 <= code <= 0xDFFF:
                fail("generation_json_identity")
            if character in escapes:
                output.append(escapes[character])
            elif code < 0x20:
                output.append(f"\\u{code:04x}")
            else:
                output.append(character)
        output.append('"')
        return "".join(output)

    def utf16_key(value: str) -> bytes:
        return value.encode("utf-16-be")

    def serialize(value) -> str:
        if isinstance(value, JsonNumber):
            return str(value)
        if isinstance(value, str):
            return string(value)
        if value is None:
            return "null"
        if value is True:
            return "true"
        if value is False:
            return "false"
        if isinstance(value, list):
            return "[" + ",".join(serialize(item) for item in value) + "]"
        if isinstance(value, dict):
            return "{" + ",".join(
                f"{string(key)}:{serialize(value[key])}"
                for key in sorted(value, key=utf16_key)
            ) + "}"
        fail("generation_json_identity")

    return serialize(value).encode("utf-8")


def validate_source_identity(identity) -> None:
    if set(identity or {}) != {
        "executablePath", "resolvedPath", "device", "inode", "version",
    }:
        fail("generation_source_identity")
    for key in ("executablePath", "resolvedPath"):
        value = identity[key]
        if (not isinstance(value, str) or not value.startswith("/")
                or os.path.normpath(value) != value
                or any(ord(character) < 0x20 for character in value)
                or len(value.encode("utf-8")) > 4096):
            fail("generation_source_identity")
    for key in ("device", "inode"):
        value = identity[key]
        if (not isinstance(value, str)
                or not re.fullmatch(r"0|[1-9][0-9]*", value)
                or int(value) > 2**64 - 1):
            fail("generation_source_identity")
    if int(identity["inode"]) == 0 or not isinstance(identity["version"], str):
        fail("generation_source_identity")
    if not SEMVER.fullmatch(identity["version"]):
        fail("generation_source_identity")


def schema_digest(protocol: Path, inventory: list[str]) -> str:
    expected_files = {
        "SHA256SUMS", "manifest.json",
        "model-decision-envelope-v1.schema.json", *inventory,
    }
    expected_directories = set()
    for relative in expected_files:
        parts = relative.split("/")[:-1]
        for index in range(1, len(parts) + 1):
            expected_directories.add("/".join(parts[:index]))
    entries = tree_entries(protocol)
    actual_files = {
        relative for relative, metadata in entries
        if stat.S_ISREG(metadata.st_mode)
    }
    actual_directories = {
        relative for relative, metadata in entries
        if stat.S_ISDIR(metadata.st_mode)
    }
    if actual_files != expected_files or actual_directories != expected_directories:
        fail("generation_protocol_inventory")
    value = hashlib.sha256()
    for relative in inventory:
        raw = (protocol / relative).read_bytes()
        canonical = canonical_json(raw)
        if raw != canonical:
            fail("generation_schema_canonical_identity")
        value.update((SCHEMA_LOGICAL_PREFIX + relative).encode("utf-8"))
        value.update(b"\0")
        value.update(canonical)
        value.update(b"\0")
    return value.hexdigest()


def tree_entries(root: Path) -> list[tuple[str, os.stat_result]]:
    output: list[tuple[str, os.stat_result]] = []

    def visit(directory: Path) -> None:
        with os.scandir(directory) as children:
            entries = sorted(children, key=lambda child: os.fsencode(child.name))
        for child in entries:
            if any(ord(character) < 0x20 or ord(character) == 0x7F
                   for character in child.name):
                fail("generation_path_rejected")
            path = Path(child.path)
            relative = path.relative_to(root).as_posix()
            metadata = path.lstat()
            output.append((relative, metadata))
            if stat.S_ISDIR(metadata.st_mode):
                visit(path)

    visit(root)
    output.sort(key=lambda entry: os.fsencode(entry[0]))
    return output


def checksum_inventory(
    root: Path,
    manifest_name: str,
    expected_uid: int,
    include,
) -> None:
    manifest = root / manifest_name
    metadata = manifest.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != expected_uid
            or metadata.st_nlink != 1 or metadata.st_mode & 0o022):
        fail("generation_checksum_identity")
    raw = manifest.read_text("utf-8")
    if not raw.endswith("\n"):
        fail("generation_checksum_manifest")
    records: list[tuple[str, str]] = []
    for line in raw[:-1].split("\n"):
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._/@-]+)", line)
        if not match:
            fail("generation_checksum_manifest")
        relative = match.group(2)
        if (relative.startswith("/") or any(
                part in ("", ".", "..") for part in relative.split("/"))):
            fail("generation_checksum_manifest")
        records.append((relative, match.group(1)))
    paths = [record[0] for record in records]
    if paths != sorted(set(paths), key=os.fsencode):
        fail("generation_checksum_manifest")
    entries = tree_entries(root)
    for relative, metadata in entries:
        if "/rootfs/" not in relative:
            if (not stat.S_ISDIR(metadata.st_mode)
                    and not stat.S_ISREG(metadata.st_mode)):
                fail("generation_tree_special_file")
            if (stat.S_ISLNK(metadata.st_mode)
                    or metadata.st_uid != expected_uid
                    or (not stat.S_ISLNK(metadata.st_mode)
                        and metadata.st_mode & 0o022)):
                fail("generation_tree_identity")
    actual = [
        relative for relative, metadata in entries
        if stat.S_ISREG(metadata.st_mode)
        and relative != manifest_name and include(relative)
    ]
    if paths != actual:
        fail("generation_checksum_inventory")
    for relative, expected in records:
        target = root / relative
        metadata = target.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != expected_uid
                or metadata.st_nlink != 1 or metadata.st_mode & 0o022):
            fail("generation_file_identity")
        if digest_file(target) != expected:
            fail("generation_checksum_mismatch")


def rootfs_digest(root: Path, expected_uid: int) -> str:
    root_metadata = root.lstat()
    expected_device = root_metadata.st_dev
    if (not stat.S_ISDIR(root_metadata.st_mode)
            or root_metadata.st_uid != expected_uid
            or root_metadata.st_mode & 0o022):
        fail("generation_rootfs_identity")
    records: list[tuple[str, bytes]] = []
    for relative, metadata in tree_entries(root):
        if metadata.st_uid != expected_uid or metadata.st_dev != expected_device:
            fail("generation_rootfs_identity")
        path = root / relative
        mode = stat.S_IMODE(metadata.st_mode)
        if stat.S_ISLNK(metadata.st_mode):
            if metadata.st_nlink != 1:
                fail("generation_rootfs_link_count")
            record = b"l:" + os.fsencode(os.readlink(path))
        elif stat.S_ISDIR(metadata.st_mode):
            if mode & 0o022:
                fail("generation_rootfs_identity")
            record = f"d:{mode:o}".encode()
        elif stat.S_ISREG(metadata.st_mode):
            if mode & 0o022 or metadata.st_nlink != 1:
                fail("generation_rootfs_identity")
            record = (
                f"f:{mode:o}:{metadata.st_size}:{digest_file(path)}".encode()
            )
        else:
            fail("generation_rootfs_special_file")
        records.append((relative, record))
    value = hashlib.sha256()
    for relative, record in sorted(records, key=lambda item: os.fsencode(item[0])):
        path_bytes = relative.encode()
        value.update(len(path_bytes).to_bytes(8, "big"))
        value.update(path_bytes)
        value.update(len(record).to_bytes(8, "big"))
        value.update(record)
    return value.hexdigest()


def main() -> None:
    if len(sys.argv) != 3:
        fail("generation_verifier_arguments")
    root = Path(sys.argv[1])
    expected_uid = int(sys.argv[2])
    if not root.is_absolute() or root.resolve() != root or root.is_symlink():
        fail("generation_root_identity")
    root_metadata = root.lstat()
    if (not stat.S_ISDIR(root_metadata.st_mode)
            or root_metadata.st_uid != expected_uid
            or root_metadata.st_mode & 0o022):
        fail("generation_root_identity")
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    if set(manifest) != {
        "formatVersion", "buildTimestamp", "codexAppServer", "codeRuntime",
        "bundleDigests", "policyHashes", "brokerContractSha256",
        "binaryHashes",
    } or manifest["formatVersion"] != 1 or (
        manifest["brokerContractSha256"] != BROKER_CONTRACT_SHA256
    ) or manifest.get("codeRuntime") != CODE_RUNTIME or set(
        manifest.get("bundleDigests", {})
    ) != {
        "code-v1", "codex-v1",
    } or set(manifest.get("policyHashes", {})) != {
        "bundles.json", "code-seccomp.json", "codex-seccomp.json",
    } or set(manifest.get("binaryHashes", {})) != {
        "acceptance-restart-broker", "firecrawl-browser-execution-adapter",
        "firecrawl-sandbox-broker",
    }:
        fail("generation_manifest_identity")
    if (not isinstance(manifest.get("buildTimestamp"), str)
            or not TIMESTAMP.fullmatch(manifest["buildTimestamp"])):
        fail("generation_manifest_identity")
    try:
        datetime.strptime(
            manifest["buildTimestamp"],
            "%Y-%m-%dT%H:%M:%S.%fZ",
        )
    except ValueError:
        fail("generation_manifest_identity")

    checksum_inventory(
        root,
        "SHA256SUMS",
        expected_uid,
        lambda relative: "/rootfs/" not in relative,
    )
    protocol = root / "protocol/codex-app-server"
    checksum_inventory(
        protocol,
        "SHA256SUMS",
        expected_uid,
        lambda relative: relative != "manifest.json",
    )
    codex_manifest = json.loads(
        (root / "codex-app-server.manifest.json").read_text("utf-8")
    )
    protocol_manifest = json.loads(
        (root / "protocol/codex-app-server.manifest.json").read_text("utf-8")
    )
    if (set(codex_manifest) != {
            "formatVersion", "sourceIdentity", "artifactSha256",
            "protocolSha256", "featureSha256", "gateAttestationSha256",
            "model", "reasoningEffort", "buildTimestamp",
    } or codex_manifest != protocol_manifest
            or codex_manifest != manifest["codexAppServer"]
            or codex_manifest.get("formatVersion") != 1
            or codex_manifest.get("buildTimestamp")
            != manifest.get("buildTimestamp")):
        fail("generation_codex_manifest_identity")
    validate_source_identity(codex_manifest.get("sourceIdentity"))
    if (codex_manifest.get("model") != "gpt-5.6-terra"
            or codex_manifest.get("reasoningEffort") != "medium"
            or any(not SHA256.fullmatch(codex_manifest.get(key, ""))
                   for key in (
                       "artifactSha256", "protocolSha256", "featureSha256",
                       "gateAttestationSha256",
                   ))):
        fail("generation_codex_manifest_identity")
    if digest_file(root / "codex-app-server.tar") != codex_manifest["artifactSha256"]:
        fail("generation_codex_artifact_identity")
    snapshot = json.loads((protocol / "manifest.json").read_text("utf-8"))
    if (set(snapshot) != {
            "formatVersion", "codexIdentity", "schemaDigest", "schemaInventory",
    } or snapshot.get("formatVersion") != 1
            or snapshot.get("schemaDigest") != codex_manifest.get("protocolSha256")
            or snapshot.get("codexIdentity") != codex_manifest.get("sourceIdentity")
            or not isinstance(snapshot.get("schemaInventory"), list)
            or any(not isinstance(path, str)
                   or not re.fullmatch(r"[A-Za-z0-9._/-]+\.json", path)
                   or path.startswith("/")
                   or any(part in ("", ".", "..") for part in path.split("/"))
                   for path in snapshot.get("schemaInventory", []))
            or snapshot["schemaInventory"] != sorted(
                set(snapshot["schemaInventory"]),
                key=lambda value: value.encode("utf-16-be"),
            )
            or schema_digest(protocol, snapshot["schemaInventory"])
            != snapshot.get("schemaDigest")):
        fail("generation_protocol_identity")
    gate = json.loads((root / "gate-attestation.json").read_text("utf-8"))
    expected_gate_integers = {
        "formatVersion": 1,
        "runCount": 3,
        "turns": 6,
        "actions": 3,
        "writes": 3,
        "tools": 0,
        "approvals": 0,
    }
    if (set(gate) != {
            "formatVersion", "codexIdentity", "model", "reasoningEffort",
            "runCount", "turns", "actions", "writes", "tools", "approvals",
            "schemaSha256", "featureSha256",
    } or gate.get("codexIdentity") != codex_manifest.get("sourceIdentity")
            or gate.get("schemaSha256") != codex_manifest.get("protocolSha256")
            or gate.get("featureSha256") != codex_manifest.get("featureSha256")
            or gate.get("model") != codex_manifest.get("model")
            or gate.get("reasoningEffort")
            != codex_manifest.get("reasoningEffort")
            or digest_file(root / "gate-attestation.json")
            != codex_manifest.get("gateAttestationSha256")
            or any(type(gate.get(key)) is not int
                   or gate.get(key) != expected
                   for key, expected in expected_gate_integers.items())):
        fail("generation_gate_identity")
    if (digest_file(root / "protocol/sandbox-broker-v1.contract.json")
            != BROKER_CONTRACT_SHA256):
        fail("generation_contract_identity")
    for name, expected in manifest["policyHashes"].items():
        if not SHA256.fullmatch(expected) or digest_file(root / "policy" / name) != expected:
            fail("generation_policy_identity")
    for name, expected in manifest["binaryHashes"].items():
        path = root / "bin" / name
        metadata = path.lstat()
        if (not SHA256.fullmatch(expected)
                or not stat.S_ISREG(metadata.st_mode)
                or not metadata.st_mode & 0o100
                or digest_file(path) != expected):
            fail("generation_binary_identity")
    for bundle, expected in manifest["bundleDigests"].items():
        identity = json.loads(
            (root / "bundles" / bundle / "rootfs.identity.json").read_text("utf-8")
        )
        if (identity != {
                "version": 1, "bundleId": bundle, "rootfsSha256": expected
        } or not SHA256.fullmatch(expected)):
            fail("generation_rootfs_manifest")
        if rootfs_digest(root / "bundles" / bundle / "rootfs", expected_uid) != expected:
            fail("generation_rootfs_digest")
    print("firecrawl_generation_identity: PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
