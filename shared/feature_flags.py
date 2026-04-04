from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _coerce_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}
    return False


def load_feature_flags(path: str | Path | None, defaults: dict[str, bool] | None = None) -> dict[str, bool]:
    flags = dict(defaults or {})
    if not path:
        return flags
    file_path = Path(path)
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return flags
    if not isinstance(payload, dict):
        return flags
    raw_flags = payload.get("flags") if isinstance(payload.get("flags"), dict) else payload
    for key, value in raw_flags.items():
        if isinstance(key, str) and key.strip():
            flags[str(key).strip()] = _coerce_flag(value)
    return flags