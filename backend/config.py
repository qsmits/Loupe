import json
import logging
import pathlib

log = logging.getLogger(__name__)

CONFIG_PATH = pathlib.Path(__file__).parent.parent / "config.json"
_DEFAULTS = {"camera_id": None, "version": 1, "no_camera": False}


def load_config() -> dict:
    """Return config dict. Missing keys fall back to defaults. File missing → all defaults."""
    if not CONFIG_PATH.exists():
        return dict(_DEFAULTS)
    try:
        data = json.loads(CONFIG_PATH.read_text())
        version = data.get("version")
        if version is None:
            # v0 file — silent upgrade on next write; fill in defaults for missing keys
            return {**_DEFAULTS, **data}
        if version == 1:
            return {**_DEFAULTS, **data}
        # version > 1: unknown future format — warn and pass through all keys
        log.warning(
            "config.json has version %s which is newer than this software (version 1). "
            "Unknown fields will be preserved.",
            version,
        )
        return {**_DEFAULTS, **data}
    except Exception:
        return dict(_DEFAULTS)


def save_config(data: dict) -> None:
    """Merge data into existing config and write atomically via a temp file."""
    current = load_config()
    current.update(data)
    tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(current, indent=2))
    tmp.replace(CONFIG_PATH)
