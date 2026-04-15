import json
import logging
import pathlib

log = logging.getLogger(__name__)

CONFIG_PATH = pathlib.Path(__file__).parent.parent / "config.json"
_DEFAULTS = {
    "camera_id": None,
    "version": 1,
    "no_camera": False,
    "hosted": False,
    "theme": "macos-dark",
    "tolerance_warn": 0.10,
    "tolerance_fail": 0.25,
    "subpixel_method": "parabola",
    "max_sessions": 50,
    "session_ttl": 1800,
    "fringe_wavelengths": [
        {"id": "sodium", "label": "Sodium (589 nm)", "nm": 589.0},
        {"id": "hene", "label": "HeNe (632.8 nm)", "nm": 632.8},
        {"id": "green", "label": "Green LED (532 nm)", "nm": 532.0},
    ],
    "fringe_standards": [
        {"id": "iso3650-k",  "label": "ISO 3650 Grade K (calibration)",  "pv_nm": 50},
        {"id": "iso3650-0",  "label": "ISO 3650 Grade 0 (reference)",    "pv_nm": 100},
        {"id": "iso3650-1",  "label": "ISO 3650 Grade 1 (inspection)",   "pv_nm": 150},
        {"id": "iso3650-2",  "label": "ISO 3650 Grade 2 (workshop)",     "pv_nm": 250},
        {"id": "jis7506-k",  "label": "JIS B 7506 Grade K",              "pv_nm": 50},
        {"id": "jis7506-0",  "label": "JIS B 7506 Grade 0",              "pv_nm": 100},
        {"id": "jis7506-1",  "label": "JIS B 7506 Grade 1",              "pv_nm": 150},
        {"id": "jis7506-2",  "label": "JIS B 7506 Grade 2",              "pv_nm": 250},
        {"id": "asme-00",    "label": "ASME B89.1.9 Grade 00",           "pv_nm": 25},
        {"id": "asme-0",     "label": "ASME B89.1.9 Grade 0",            "pv_nm": 50},
        {"id": "asme-as1",   "label": "ASME B89.1.9 Grade AS-1",         "pv_nm": 75},
        {"id": "asme-as2",   "label": "ASME B89.1.9 Grade AS-2",         "pv_nm": 75},
        {"id": "din861-k",   "label": "DIN 861 Grade K",                 "pv_nm": 50},
        {"id": "din861-0",   "label": "DIN 861 Grade 0",                 "pv_nm": 100},
        {"id": "din861-1",   "label": "DIN 861 Grade 1",                 "pv_nm": 150},
        {"id": "din861-2",   "label": "DIN 861 Grade 2",                 "pv_nm": 250},
    ],
    "deflectometry_profiles": [],
    "deflectometry_active_profile": None,
}


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
