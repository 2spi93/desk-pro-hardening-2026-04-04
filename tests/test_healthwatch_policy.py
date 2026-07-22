from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts.healthwatch_atomic import atomic_write_json
from scripts.healthwatch_incident_policy import evaluate_incident
from scripts.healthwatch_retention import RetentionPolicy, build_plan


START = datetime(2026, 7, 22, 12, 0, tzinfo=timezone.utc)


def probe(*reasons: str, offline: bool = True) -> dict:
    return {
        "offline": offline,
        "offline_reasons": list(reasons),
        "public_signal_alignment": {"snapshot_health_reason": reasons[0] if reasons else "live_stream_ok"},
        "connectors": {"snapshot": {"status": 503 if offline else 200}},
    }


class HealthwatchIncidentPolicyTests(unittest.TestCase):
    def test_sixty_identical_failures_create_one_full_capture(self) -> None:
        state = None
        decisions = []
        for minute in range(60):
            state, decision = evaluate_incident(
                probe("control_plane_snapshot_unavailable"),
                state,
                START + timedelta(minutes=minute),
            )
            decisions.append(decision)

        self.assertEqual(sum(bool(item["capture_full"]) for item in decisions), 1)
        self.assertEqual(state["occurrences"], 60)
        self.assertEqual(decisions[0]["event"], "FIRST_FAILURE")
        self.assertEqual(sum(bool(item["write_daily_summary"]) for item in decisions), 1)
        self.assertTrue(all(item["event"] == "COUNTER_ONLY" for item in decisions[1:]))

    def test_hourly_evidence_is_bounded(self) -> None:
        state, first = evaluate_incident(probe("same"), None, START)
        state, hourly = evaluate_incident(probe("same"), state, START + timedelta(minutes=60))
        self.assertTrue(first["capture_full"])
        self.assertEqual(hourly["event"], "HOURLY_EVIDENCE")
        self.assertTrue(hourly["capture_full"])

    def test_signature_change_recovery_and_new_incident_are_captured(self) -> None:
        state = None
        events = []
        for minute in range(23):
            if minute < 17:
                current = probe("signature-a")
            elif minute < 22:
                current = probe("signature-b")
            else:
                current = probe(offline=False)
            state, decision = evaluate_incident(current, state, START + timedelta(minutes=minute))
            if decision["capture_full"]:
                events.append(decision["event"])
        state, next_incident = evaluate_incident(probe("signature-c"), state, START + timedelta(minutes=23))

        self.assertEqual(events, ["FIRST_FAILURE", "SIGNATURE_CHANGE", "RECOVERY"])
        self.assertEqual(next_incident["event"], "FIRST_FAILURE")
        self.assertEqual(state["incident_sequence"], 3)

    def test_signature_is_order_stable(self) -> None:
        state_a, decision_a = evaluate_incident(probe("a", "b"), None, START)
        state_b, decision_b = evaluate_incident(probe("b", "a"), None, START)
        self.assertEqual(decision_a["signature"], decision_b["signature"])
        self.assertEqual(state_a["signature"], state_b["signature"])

    def test_malformed_probe_fails_into_a_stable_incident_signature(self) -> None:
        state, decision = evaluate_incident(
            {"offline": True, "offline_reasons": "not-a-list", "connectors": []},
            None,
            START,
        )
        self.assertEqual(decision["event"], "FIRST_FAILURE")
        self.assertTrue(decision["capture_full"])
        self.assertEqual(len(state["signature"]), 64)


class AtomicAndRetentionTests(unittest.TestCase):
    def test_atomic_json_never_leaves_temporary_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "latest.json"
            atomic_write_json(target, {"state": "healthy"})
            self.assertEqual(json.loads(target.read_text()), {"state": "healthy"})
            self.assertEqual(list(Path(directory).glob(".latest.json.*")), [])

    def test_atomic_json_is_always_parseable_under_concurrent_reads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "latest.json"
            atomic_write_json(target, {"sequence": 0, "payload": "x" * 4096})
            errors: list[Exception] = []

            def writer() -> None:
                for sequence in range(1, 100):
                    atomic_write_json(target, {"sequence": sequence, "payload": "x" * 4096})

            thread = threading.Thread(target=writer)
            thread.start()
            while thread.is_alive():
                try:
                    json.loads(target.read_text())
                except Exception as exc:  # pragma: no cover - assertion records the race
                    errors.append(exc)
            thread.join()
            self.assertEqual(errors, [])

    def test_retention_plan_is_non_mutating_and_bounded(self) -> None:
        records = [
            {"path": "recent", "event": "HOURLY_EVIDENCE", "captured_at": (START - timedelta(days=1)).isoformat()},
            {"path": "transition", "event": "RECOVERY", "captured_at": (START - timedelta(days=30)).isoformat()},
            {"path": "summary", "event": "DAILY_SUMMARY", "captured_at": (START - timedelta(days=30)).isoformat()},
            {"path": "noise", "event": "HOURLY_EVIDENCE", "captured_at": (START - timedelta(days=30)).isoformat()},
            {"path": "expired", "event": "FIRST_FAILURE", "captured_at": (START - timedelta(days=91)).isoformat()},
        ]
        plan = build_plan(records, START, RetentionPolicy())
        self.assertEqual(plan["counts"], {
            "KEEP_RAW": 1,
            "COMPRESS_TRANSITION": 1,
            "KEEP_DAILY_SUMMARY": 1,
            "DELETE_CANDIDATE": 2,
        })
        self.assertFalse(plan["deletion_executed"])


class HealthwatchProbeShellTests(unittest.TestCase):
    def test_healthy_probe_updates_latest_without_full_capture(self) -> None:
        repository = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe_path = root / "probe.json"
            probe_path.write_text(json.dumps({"offline": False, "offline_reasons": []}))
            result = subprocess.run(
                [str(repository / "scripts/capture_chart_offline_context.sh")],
                env={
                    **os.environ,
                    "CAPTURE_PROBE_INPUT": str(probe_path),
                    "CAPTURE_PERSIST_ON_CRITICAL": "0",
                    "HEALTHWATCH_CHART_LOG_ROOT": str(root / "captures"),
                },
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((root / "captures/latest-probe.json").read_text())["offline"], False)
            self.assertEqual([path for path in (root / "captures").iterdir() if path.is_dir()], [])

    def test_offline_probe_without_persistence_is_fail_closed(self) -> None:
        repository = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe_path = root / "probe.json"
            probe_path.write_text(json.dumps({"offline": True, "offline_reasons": ["synthetic"]}))
            result = subprocess.run(
                [str(repository / "scripts/capture_chart_offline_context.sh")],
                env={
                    **os.environ,
                    "CAPTURE_PROBE_INPUT": str(probe_path),
                    "CAPTURE_PERSIST_ON_CRITICAL": "0",
                    "HEALTHWATCH_CHART_LOG_ROOT": str(root / "captures"),
                },
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 10, result.stderr)
            self.assertEqual([path for path in (root / "captures").iterdir() if path.is_dir()], [])


if __name__ == "__main__":
    unittest.main()
