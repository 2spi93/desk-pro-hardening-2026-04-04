from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .brain import Experience, FailureSourceLearningRateCalibrator, _resolve_timestamp_ms
from .config import EXPERIENCES_LOG_PATH, FAILURE_LR_CALIBRATION_HISTORY_LIMIT, FAILURE_LR_CALIBRATION_HISTORY_PATH, SERVICE_NAME
from .storage import load_json, save_json

DEFAULT_WINDOWS: tuple[tuple[str, int | None], ...] = (
    ("24h", 24 * 60 * 60 * 1000),
    ("7d", 7 * 24 * 60 * 60 * 1000),
    ("30d", 30 * 24 * 60 * 60 * 1000),
    ("all", None),
)


def _utc_iso(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc).isoformat()


def _repo_data_path(filename: str) -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "predictor_v8" / filename


def resolve_effective_experiences_log_path(configured_path: Path | None = None) -> Path:
    candidate = configured_path or EXPERIENCES_LOG_PATH
    if candidate.exists():
        return candidate
    fallback = _repo_data_path("experiences.jsonl")
    if str(candidate).startswith("/workspace/") and fallback.exists():
        return fallback
    return candidate


def resolve_effective_calibration_history_path(configured_path: Path | None = None) -> Path:
    candidate = configured_path or FAILURE_LR_CALIBRATION_HISTORY_PATH
    fallback = _repo_data_path("failure_lr_calibration_history.json")
    if str(candidate).startswith("/workspace/"):
        if candidate.exists() or candidate.parent.exists():
            return candidate
        return fallback
    return candidate


def _load_experience_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                payload = line.strip()
                if not payload:
                    continue
                try:
                    parsed = json.loads(payload)
                except Exception:
                    continue
                if isinstance(parsed, dict):
                    rows.append(parsed)
    except Exception:
        return []
    return rows


def _coerce_history_entries(payload: dict[str, Any], history_limit: int) -> list[dict[str, Any]]:
    history = payload.get("history") if isinstance(payload.get("history"), list) else []
    entries = [entry for entry in history if isinstance(entry, dict)]
    return entries[-history_limit:]


def _build_window_snapshot(
    rows: list[dict[str, Any]],
    *,
    label: str,
    window_ms: int | None,
    as_of_ms: int,
    source_path: Path,
) -> dict[str, Any]:
    start_ms = as_of_ms - window_ms if window_ms is not None else None
    calibrator = FailureSourceLearningRateCalibrator()
    experience_rows = 0
    real_rows = 0
    synthetic_rows = 0
    failure_rows = 0
    real_failure_rows = 0
    oldest_ms: int | None = None
    newest_ms: int | None = None

    for row in rows:
        timestamp_ms = _resolve_timestamp_ms(row)
        if window_ms is not None and timestamp_ms < (start_ms or 0):
            continue
        experience = Experience.from_payload(row)
        if experience is None:
            continue
        experience_rows += 1
        if experience.synthetic:
            synthetic_rows += 1
        else:
            real_rows += 1
        if experience.failure_source is not None:
            failure_rows += 1
            if not experience.synthetic:
                real_failure_rows += 1
        calibrator.observe_experience(experience)
        oldest_ms = timestamp_ms if oldest_ms is None else min(oldest_ms, timestamp_ms)
        newest_ms = timestamp_ms if newest_ms is None else max(newest_ms, timestamp_ms)

    return {
        "label": label,
        "window_ms": window_ms,
        "generated_at": _utc_iso(as_of_ms),
        "start_at": _utc_iso(start_ms) if start_ms is not None else None,
        "end_at": _utc_iso(as_of_ms),
        "source_path": str(source_path),
        "experience_rows": experience_rows,
        "real_rows": real_rows,
        "synthetic_rows": synthetic_rows,
        "failure_rows": failure_rows,
        "real_failure_rows": real_failure_rows,
        "oldest_experience_at": _utc_iso(oldest_ms) if oldest_ms is not None else None,
        "newest_experience_at": _utc_iso(newest_ms) if newest_ms is not None else None,
        "sources": calibrator.summary().get("sources", {}),
    }


def build_failure_lr_calibration_history(
    *,
    experiences_path: Path | None = None,
    history_path: Path | None = None,
    history_limit: int = FAILURE_LR_CALIBRATION_HISTORY_LIMIT,
    as_of_ms: int | None = None,
) -> dict[str, Any]:
    resolved_experiences = resolve_effective_experiences_log_path(experiences_path)
    resolved_history = resolve_effective_calibration_history_path(history_path)
    resolved_limit = max(8, history_limit)
    now_ms = as_of_ms if as_of_ms is not None else int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    rows = _load_experience_rows(resolved_experiences)
    windows = {
        label: _build_window_snapshot(rows, label=label, window_ms=window_ms, as_of_ms=now_ms, source_path=resolved_experiences)
        for label, window_ms in DEFAULT_WINDOWS
    }
    existing = load_json(resolved_history) or {}
    history_entries = _coerce_history_entries(existing, resolved_limit)
    history_entries.append({
        "generated_at": _utc_iso(now_ms),
        "row_count": len(rows),
        "windows": windows,
    })
    history_entries = history_entries[-resolved_limit:]
    payload = {
        "service": SERVICE_NAME,
        "generated_at": _utc_iso(now_ms),
        "source_path": str(resolved_experiences),
        "history_path": str(resolved_history),
        "history_limit": resolved_limit,
        "row_count": len(rows),
        "window_order": [label for label, _ in DEFAULT_WINDOWS],
        "windows": windows,
        "history": history_entries,
    }
    save_json(resolved_history, payload)
    return payload


def load_failure_lr_calibration_history(
    *,
    history_path: Path | None = None,
    history_limit: int = FAILURE_LR_CALIBRATION_HISTORY_LIMIT,
) -> dict[str, Any] | None:
    resolved_history = resolve_effective_calibration_history_path(history_path)
    payload = load_json(resolved_history)
    if not isinstance(payload, dict):
        return None
    resolved_limit = max(8, history_limit)
    payload["history"] = _coerce_history_entries(payload, resolved_limit)
    payload["history_limit"] = resolved_limit
    payload.setdefault("history_path", str(resolved_history))
    payload.setdefault("window_order", [label for label, _ in DEFAULT_WINDOWS])
    payload.setdefault("service", SERVICE_NAME)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild failure-source LR calibration history from predictor replay rows.")
    parser.add_argument("--history-limit", type=int, default=FAILURE_LR_CALIBRATION_HISTORY_LIMIT)
    parser.add_argument("--print", action="store_true", dest="print_payload")
    args = parser.parse_args()
    payload = build_failure_lr_calibration_history(history_limit=max(8, args.history_limit))
    if args.print_payload:
        print(json.dumps(payload, indent=2, ensure_ascii=True))
    else:
        print(json.dumps({
            "generated_at": payload.get("generated_at"),
            "history_path": payload.get("history_path"),
            "row_count": payload.get("row_count"),
            "windows": list((payload.get("windows") or {}).keys()),
        }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())