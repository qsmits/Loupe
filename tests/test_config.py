import json
import logging
import pytest
from backend.config import load_config, save_config, CONFIG_PATH


def test_config_load_defaults_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    result = load_config()
    assert result == {"camera_id": None, "version": 1, "no_camera": False}


def test_config_save_and_load(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    save_config({"camera_id": "Aravis-USB0-abc123"})
    result = load_config()
    assert result["camera_id"] == "Aravis-USB0-abc123"


def test_config_load_merges_defaults(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    # Write a partial config missing camera_id
    path.write_text(json.dumps({}))
    result = load_config()
    assert "camera_id" in result
    assert result["camera_id"] is None


def test_config_defaults_include_version(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.config.CONFIG_PATH", tmp_path / "config.json")
    result = load_config()
    assert result["version"] == 1


def test_config_save_writes_version(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    save_config({"camera_id": "Baumer-001"})
    on_disk = json.loads(path.read_text())
    assert on_disk["version"] == 1


def test_config_load_v0_no_warning(tmp_path, monkeypatch, caplog):
    """v0 file (no version field) loads silently with defaults filled in."""
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    path.write_text(json.dumps({"camera_id": "Baumer-001"}))
    with caplog.at_level(logging.WARNING, logger="backend.config"):
        result = load_config()
    assert result["version"] == 1
    assert result["camera_id"] == "Baumer-001"
    assert not caplog.records


def test_config_load_v1_loads_normally(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    path.write_text(json.dumps({"version": 1, "camera_id": "Baumer-001"}))
    result = load_config()
    assert result["version"] == 1
    assert result["camera_id"] == "Baumer-001"


def test_config_load_future_version_warns_and_passes_through(tmp_path, monkeypatch, caplog):
    """version > 1: log a warning, keep unknown keys, do not strip data."""
    path = tmp_path / "config.json"
    monkeypatch.setattr("backend.config.CONFIG_PATH", path)
    path.write_text(json.dumps({"version": 99, "camera_id": "Baumer-001", "new_field": "value"}))
    with caplog.at_level(logging.WARNING, logger="backend.config"):
        result = load_config()
    assert any("version" in r.message.lower() for r in caplog.records)
    assert result["version"] == 99
    assert result["new_field"] == "value"
    assert result["camera_id"] == "Baumer-001"
