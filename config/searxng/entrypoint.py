import base64
import os
import sys
import tempfile
import unicodedata
from pathlib import Path

import yaml


SOURCE_SETTINGS = Path("/etc/searxng/settings.yml")
RUNTIME_SETTINGS = Path("/tmp/firecrawl-searxng-settings.yml")
OFFICIAL_ENTRYPOINT = "/usr/local/searxng/entrypoint.sh"


def decode_api_key(encoded: str) -> str:
    if not encoded:
        raise ValueError("missing encoded credential")
    try:
        decoded = base64.b64decode(encoded, validate=True)
        if base64.b64encode(decoded).decode("ascii") != encoded:
            raise ValueError("non-canonical encoding")
        api_key = decoded.decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid encoded credential") from error
    if not api_key or any(
        character.isspace()
        or unicodedata.category(character).startswith("C")
        for character in api_key
    ):
        raise ValueError("invalid credential characters")
    return api_key


def render_settings(source: Path, destination: Path, encoded: str) -> None:
    api_key = decode_api_key(encoded)
    with source.open("r", encoding="utf-8") as source_file:
        settings = yaml.safe_load(source_file)
    if not isinstance(settings, dict) or not isinstance(
        settings.get("engines"), list
    ):
        raise ValueError("invalid base settings")

    braveapi_engines = [
        engine
        for engine in settings["engines"]
        if isinstance(engine, dict)
        and engine.get("name") == "braveapi"
        and engine.get("engine") == "braveapi"
    ]
    if len(braveapi_engines) != 1:
        raise ValueError("invalid braveapi settings")

    braveapi = braveapi_engines[0]
    braveapi["disabled"] = False
    braveapi["api_key"] = api_key
    braveapi["inactive"] = False

    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output_file:
            descriptor = -1
            yaml.safe_dump(settings, output_file, sort_keys=False)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary, destination)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


# @lat: [[lat.md/runtime/support-services#Runtime Support Services#SearXNG]]
def main() -> int:
    encoded = os.environ.pop("SEARXNG_BRAVE_API_KEY_B64", "")
    if not encoded:
        print(
            "Brave Search API key is required for bundled search; "
            "run scripts/local-firecrawl configure-search",
            file=sys.stderr,
        )
        return 78
    try:
        render_settings(SOURCE_SETTINGS, RUNTIME_SETTINGS, encoded)
    except (FileNotFoundError, PermissionError, ValueError, yaml.YAMLError):
        print("Unable to render private SearXNG settings", file=sys.stderr)
        return 78

    os.environ["SEARXNG_SETTINGS_PATH"] = str(RUNTIME_SETTINGS)
    os.execv(OFFICIAL_ENTRYPOINT, [OFFICIAL_ENTRYPOINT])
    return 70


if __name__ == "__main__":
    raise SystemExit(main())
