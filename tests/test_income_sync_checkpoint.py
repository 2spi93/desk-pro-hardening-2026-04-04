from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "income_sync_checkpoint.py"


def _load():
    spec = importlib.util.spec_from_file_location("income_sync_checkpoint", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


UTC = timezone.utc
T0 = datetime(2026, 7, 9, 0, 0, 0, tzinfo=UTC)


class CheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def _ckpt(self, status, window_end, now, prev=None, count=0):
        return self.m.build_checkpoint(
            account_id="A", provider="bingx", endpoint="/income", window_start=T0,
            window_end=window_end, fetched_event_count=count, page_or_slice_count=1,
            response_digest="d", status=status, error_code=None, now=now, prev_checkpoint=prev,
        )

    def test_success_advances_coverage(self) -> None:
        c = self._ckpt("success", T0 + timedelta(hours=1), T0 + timedelta(hours=1, seconds=5))
        self.assertEqual(c["covered_through"], (T0 + timedelta(hours=1)).isoformat())
        self.assertIsNotNone(c["last_success_at"])

    def test_partial_failure_keeps_prev_coverage(self) -> None:
        good = self._ckpt("success", T0 + timedelta(hours=1), T0 + timedelta(hours=1))
        bad = self._ckpt("error", T0 + timedelta(hours=2), T0 + timedelta(hours=2), prev=good)
        # coverage does NOT advance to hour 2 on failure — stays at hour 1
        self.assertEqual(bad["covered_through"], good["covered_through"])
        self.assertEqual(bad["last_success_at"], good["last_success_at"])
        self.assertEqual(bad["status"], "error")

    def test_no_events_still_proves_query(self) -> None:
        # a fully successful fetch with 0 events still advances coverage
        c = self._ckpt("success", T0 + timedelta(hours=3), T0 + timedelta(hours=3), count=0)
        self.assertEqual(c["fetched_event_count"], 0)
        self.assertEqual(c["covered_through"], (T0 + timedelta(hours=3)).isoformat())

    def test_append_only_and_latest_valid(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            ledger = Path(d) / "ck.jsonl"
            self.m.append_checkpoint(self._ckpt("success", T0 + timedelta(hours=1), T0 + timedelta(hours=1)), ledger=ledger)
            self.m.append_checkpoint(self._ckpt("error", T0 + timedelta(hours=2), T0 + timedelta(hours=2)), ledger=ledger)
            self.m.append_checkpoint(self._ckpt("success", T0 + timedelta(hours=3), T0 + timedelta(hours=3)), ledger=ledger)
            # 3 lines appended, none rewritten
            self.assertEqual(len(ledger.read_text().splitlines()), 3)
            latest = self.m.latest_valid_checkpoint("A", "bingx", ledger=ledger)
            self.assertEqual(latest["covered_through"], (T0 + timedelta(hours=3)).isoformat())

    def test_covered_requires_past_close_and_fresh(self) -> None:
        close = T0 + timedelta(hours=1)
        now = T0 + timedelta(hours=1, minutes=2)
        good = self._ckpt("success", T0 + timedelta(hours=1, minutes=1), now)
        v = self.m.covered_reconciled_actual(good, close, now=now, freshness_sec=900)
        self.assertTrue(v["covered"])

    def test_covered_false_when_before_close(self) -> None:
        close = T0 + timedelta(hours=5)
        now = T0 + timedelta(hours=5, minutes=1)
        early = self._ckpt("success", T0 + timedelta(hours=1), T0 + timedelta(hours=1))
        v = self.m.covered_reconciled_actual(early, close, now=now)
        self.assertFalse(v["covered"])
        self.assertEqual(v["reason"], "covered_through_before_cycle_close")

    def test_covered_false_when_stale(self) -> None:
        close = T0 + timedelta(hours=1)
        good = self._ckpt("success", T0 + timedelta(hours=2), T0 + timedelta(hours=2))
        now = T0 + timedelta(hours=10)  # checkpoint is 8h old
        v = self.m.covered_reconciled_actual(good, close, now=now, freshness_sec=900)
        self.assertFalse(v["covered"])
        self.assertEqual(v["reason"], "checkpoint_stale")

    def test_no_checkpoint_not_covered(self) -> None:
        v = self.m.covered_reconciled_actual(None, T0, now=T0)
        self.assertFalse(v["covered"])
        self.assertEqual(v["reason"], "no_valid_checkpoint")


if __name__ == "__main__":
    unittest.main()
