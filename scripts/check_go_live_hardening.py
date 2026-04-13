#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import sys


ROOT_DIR = Path(__file__).resolve().parents[1]


def require_contains(path: Path, needle: str) -> str | None:
    if not path.exists():
        return f"missing file: {path}"
    content = path.read_text(encoding="utf-8")
    if needle not in content:
        return f"missing '{needle}' in {path}"
    return None


def main() -> int:
    checks = [
        (ROOT_DIR / "apps/control_plane/main.py", "def _evaluate_go_live_hardening("),
        (ROOT_DIR / "apps/control_plane/main.py", '"/v1/system/kill-switch/activate"'),
        (ROOT_DIR / "apps/control_plane/main.py", "go_live_hardening_decision"),
        (ROOT_DIR / "apps/control_plane/main.py", '"blocked_by_go_live_hardening"'),
        (ROOT_DIR / "config/live_execution_policy.json", '"go_live_hardening"'),
        (ROOT_DIR / "config/live_execution_policy.json", '"anti_loop"'),
        (ROOT_DIR / "scripts/go_live_watchdog.py", '"/v1/system/kill-switch/activate"'),
        (ROOT_DIR / "scripts/go_live_watchdog.py", '"/v1/ai/kairos/shadow/stop"'),
        (ROOT_DIR / "scripts/go_live_watchdog.py", '"/v1/execution/reality-gap/recent"'),
    ]

    failures = [error for path, needle in checks if (error := require_contains(path, needle))]
    if failures:
        for failure in failures:
            print(f"[fail] {failure}")
        return 1

    print("[ok] go-live hardening source guard passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())