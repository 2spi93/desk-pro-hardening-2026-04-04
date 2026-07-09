from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "income_history_paginator.py"


def _load():
    spec = importlib.util.spec_from_file_location("income_history_paginator", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


UTC = timezone.utc
START = datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC)
END = datetime(2026, 7, 8, 0, 0, 0, tzinfo=UTC)  # 7 days


def _make_events(n: int, start: datetime, end: datetime):
    """n events spread uniformly across [start, end)."""
    span = (end - start).total_seconds()
    out = []
    for i in range(n):
        t = start + timedelta(seconds=span * i / max(1, n))
        out.append({"external_event_id": f"E{i:04d}", "time_dt": t, "income": f"-0.00{i % 9}"})
    return out


class PaginatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def _fetch_factory(self, all_events, limit=100):
        def fetch(ws, we):
            window = [e for e in all_events if ws <= e["time_dt"] < we]
            window.sort(key=lambda e: e["time_dt"])
            return window[:limit]  # venue caps the page at limit
        return fetch

    def test_over_100_events_7_days_no_loss_no_dup(self) -> None:
        events = _make_events(250, START, END)
        r = self.m.collect_income_complete(fetch_fn=self._fetch_factory(events), start=START, end=END, limit=100)
        self.assertTrue(r["complete"])
        self.assertEqual(r["count"], 250)          # no loss
        ids = [e["external_event_id"] for e in r["events"]]
        self.assertEqual(len(ids), len(set(ids)))  # no dup
        self.assertGreater(r["slices_used"], 1)    # it actually split

    def test_under_limit_single_window(self) -> None:
        events = _make_events(30, START, END)
        r = self.m.collect_income_complete(fetch_fn=self._fetch_factory(events), start=START, end=END, limit=100)
        self.assertTrue(r["complete"])
        self.assertEqual(r["count"], 30)
        self.assertEqual(r["slices_used"], 1)

    def test_unresolvable_saturation_fails_closed(self) -> None:
        # 150 events all within the same 30s -> cannot split below min_window
        cluster_start = START
        cluster_end = START + timedelta(seconds=30)
        events = _make_events(150, cluster_start, cluster_end)
        r = self.m.collect_income_complete(
            fetch_fn=self._fetch_factory(events), start=START, end=START + timedelta(hours=1),
            limit=100, min_window_sec=60,
        )
        self.assertFalse(r["complete"])            # fail-closed
        self.assertTrue(r["saturation_unresolved"])

    def test_sum_amounts_uses_decimal(self) -> None:
        events = [{"income": "-0.00248615"}, {"income": "-0.00248656"}, {"income": "-0.00103000"}]
        total = self.m.sum_amounts_decimal(events, "income")
        self.assertIsInstance(total, Decimal)
        self.assertEqual(total, Decimal("-0.00600271"))  # exact, no float drift

    def test_sum_ignores_invalid(self) -> None:
        events = [{"income": "-0.01"}, {"income": None}, {"income": "bad"}, {"other": 1}]
        self.assertEqual(self.m.sum_amounts_decimal(events, "income"), Decimal("-0.01"))


if __name__ == "__main__":
    unittest.main()
