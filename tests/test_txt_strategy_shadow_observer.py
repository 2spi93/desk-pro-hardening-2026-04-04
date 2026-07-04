from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_shadow_observer.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_shadow_observer", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TxtStrategyShadowObserverTests(unittest.TestCase):
    def test_observe_counts_no_opportunity_and_opportunity(self) -> None:
        mod = _load_module()
        snapshots = [{"snapshot_id": "s1"}, {"snapshot_id": "s2"}]
        reports = [
            {"status": "NO_OPPORTUNITY", "market_regime": "RANGE", "blockers": ["no_strategy_candidate"]},
            {
                "status": "OPPORTUNITY",
                "market_regime": "TREND_UP",
                "selected_strategy_id": "trend_multi_horizon",
                "blockers": [],
                "opportunity": {"side": "buy", "edge_lower_confidence_bound_bps": 1.5},
            },
        ]

        report = mod.observe(
            iterations=2,
            interval_sec=0,
            snapshot_provider=lambda: snapshots.pop(0),
            brain_builder=lambda _snapshot: reports.pop(0),
        )

        self.assertEqual(report["opportunities_detected"], 1)
        self.assertEqual(report["no_opportunity_count"], 1)
        self.assertEqual(report["latest_status"], "OPPORTUNITY")
        self.assertEqual(report["observations"][1]["side"], "buy")
        self.assertIn("no_order", report["non_actions"])

    def test_format_text_is_compact(self) -> None:
        mod = _load_module()
        text = mod.format_text(
            {
                "opportunities_detected": 0,
                "iterations": 3,
                "first_opportunity_after_sec": None,
                "latest_status": "NO_OPPORTUNITY",
                "latest_regime": "RANGE",
                "latest_blockers": ["no_strategy_candidate"],
            }
        )

        self.assertIn("opportunities=0/3", text)
        self.assertIn("latest_status=NO_OPPORTUNITY", text)

    def test_observe_can_record_pre_scan_refresh(self) -> None:
        mod = _load_module()
        calls = {"refresh": 0}

        def refresh():
            calls["refresh"] += 1
            return {"inserted_total": 2}

        report = mod.observe(
            iterations=1,
            interval_sec=0,
            pre_scan_hook=refresh,
            snapshot_provider=lambda: {"snapshot_id": "s1"},
            brain_builder=lambda _snapshot: {"status": "NO_OPPORTUNITY", "market_regime": "RANGE", "blockers": []},
        )

        self.assertTrue(report["refresh_enabled"])
        self.assertEqual(calls["refresh"], 1)
        self.assertEqual(report["observations"][0]["refresh_inserted"], 2)

    def test_observe_appends_jsonl_and_dedupes_seen_snapshot(self) -> None:
        mod = _load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            jsonl_path = Path(tmpdir) / "shadow.jsonl"
            report = mod.observe(
                iterations=2,
                interval_sec=0,
                append_jsonl_path=jsonl_path,
                seen_snapshot_keys={"digest-seen"},
                snapshot_provider=lambda: {"snapshot_id": "s1", "latest_close": 100.0},
                brain_builder=lambda _snapshot: {
                    "status": "NO_OPPORTUNITY",
                    "market_regime": "RANGE",
                    "market_snapshot_digest": "digest-seen",
                    "blockers": ["no_strategy_candidate"],
                },
            )

            self.assertEqual(report["observations_recorded"], 0)
            self.assertEqual(report["duplicates_skipped"], 2)
            self.assertFalse(jsonl_path.exists())

            report = mod.observe(
                iterations=1,
                interval_sec=0,
                append_jsonl_path=jsonl_path,
                seen_snapshot_keys=set(),
                snapshot_provider=lambda: {
                    "snapshot_id": "s2",
                    "latest_close": 100.0,
                    "latest_bar_at": "2026-06-30T00:00:00+00:00",
                    "warmup_complete": True,
                },
                brain_builder=lambda _snapshot: {
                    "status": "NO_OPPORTUNITY",
                    "market_regime": "RANGE",
                    "market_snapshot_digest": "digest-new",
                    "blockers": ["no_strategy_candidate"],
                },
            )

            self.assertEqual(report["observations_recorded"], 1)
            rows = [line for line in jsonl_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(len(rows), 1)
            self.assertIn("digest-new", rows[0])

    def test_observe_records_venue_basis_without_consuming_signal(self) -> None:
        mod = _load_module()
        report = mod.observe(
            iterations=1,
            interval_sec=0,
            snapshot_provider=lambda: {"snapshot_id": "s1", "latest_close": 100.0},
            venue_basis_provider=lambda _snapshot: {
                "status": "available",
                "executable_mid_or_mark": 101.0,
                "venue_data_lag_ms": 12.5,
                "estimated_bingx_slippage_bps": 1.0,
            },
            brain_builder=lambda _snapshot: {"status": "NO_OPPORTUNITY", "market_regime": "RANGE", "blockers": []},
        )

        row = report["observations"][0]
        self.assertTrue(report["venue_basis_enabled"])
        self.assertEqual(row["bingx_executable_mid_or_mark"], 101.0)
        self.assertAlmostEqual(row["venue_basis_bps"], 100.0)
        self.assertIn("no_signal_consumption", row["non_actions"])

    def test_load_seen_snapshot_keys_ignores_bad_jsonl(self) -> None:
        mod = _load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "seen.jsonl"
            path.write_text('{"snapshot_digest":"a"}\nnot-json\n{"snapshot_id":"b"}\n', encoding="utf-8")

            self.assertEqual(mod.load_seen_snapshot_keys(path), {"a", "b"})

    def test_single_instance_lock_refuses_second_holder(self) -> None:
        mod = _load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            lock_path = Path(tmpdir) / "observer.lock"

            first = mod.acquire_single_instance_lock(lock_path)
            self.assertIsNotNone(first)
            self.assertEqual(lock_path.read_text(encoding="utf-8").strip(), str(__import__("os").getpid()))

            second = mod.acquire_single_instance_lock(lock_path)
            self.assertIsNone(second)

            first.close()
            third = mod.acquire_single_instance_lock(lock_path)
            self.assertIsNotNone(third)
            third.close()


if __name__ == "__main__":
    unittest.main()
