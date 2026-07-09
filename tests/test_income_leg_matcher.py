from __future__ import annotations

import importlib.util
from decimal import Decimal
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "income_leg_matcher.py"


def _load():
    spec = importlib.util.spec_from_file_location("income_leg_matcher", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


# 091216 entry order update ~ ms; 092000 (adjacent) ~ 8 min later
BASE_MS = 1_780_000_000_000
ADJ_MS = BASE_MS + 8 * 60 * 1000


def _ev(itype, amount, time_ms, eid, symbol="BTC-USDT"):
    return {"income_type": itype, "amount": amount, "time_ms": time_ms, "symbol": symbol, "external_event_id": eid}


class MatcherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_unique_candidate_is_aligned(self) -> None:
        income = [_ev("trading_fee", "-0.00248615", BASE_MS + 1000, "E1")]
        r = self.m.match_quantity(order_value="-0.002486", order_update_ms=BASE_MS,
                                  symbol="BTC-USDT", income_type="trading_fee", income_events=income)
        self.assertEqual(r["status"], "ALIGNED")
        self.assertEqual(r["matched_event_id"], "E1")

    def test_adjacent_cycle_excluded_by_time_criterion(self) -> None:
        # 091216's own event + 092000's event (8 min away, similar amount)
        income = [
            _ev("trading_fee", "-0.00248615", BASE_MS + 1000, "OWN"),
            _ev("trading_fee", "-0.00248700", ADJ_MS, "ADJACENT"),
        ]
        r = self.m.match_quantity(order_value="-0.002486", order_update_ms=BASE_MS,
                                  symbol="BTC-USDT", income_type="trading_fee", income_events=income)
        # the adjacent event is outside the time window -> unique -> ALIGNED on OWN
        self.assertEqual(r["status"], "ALIGNED")
        self.assertEqual(r["matched_event_id"], "OWN")

    def test_two_events_in_window_same_amount_is_ambiguous(self) -> None:
        income = [
            _ev("trading_fee", "-0.002486", BASE_MS + 1000, "A"),
            _ev("trading_fee", "-0.002486", BASE_MS + 2000, "B"),
        ]
        r = self.m.match_quantity(order_value="-0.002486", order_update_ms=BASE_MS,
                                  symbol="BTC-USDT", income_type="trading_fee", income_events=income)
        self.assertEqual(r["status"], "AMBIGUOUS")

    def test_no_candidate_is_missing(self) -> None:
        r = self.m.match_quantity(order_value="-0.002486", order_update_ms=BASE_MS,
                                  symbol="BTC-USDT", income_type="trading_fee", income_events=[])
        self.assertEqual(r["status"], "MISSING")

    def test_incompatible_amount_is_divergent(self) -> None:
        income = [_ev("trading_fee", "-0.5", BASE_MS + 1000, "BIG")]  # in time/type window, wrong amount
        r = self.m.match_quantity(order_value="-0.002486", order_update_ms=BASE_MS,
                                  symbol="BTC-USDT", income_type="trading_fee", income_events=income)
        self.assertEqual(r["status"], "DIVERGENT")

    def test_cycle_cross_check_aligned_excludes_adjacent(self) -> None:
        legs = [
            {"order_update_ms": BASE_MS, "commission_usd": "-0.002486", "profit_usd": "0.0"},
            {"order_update_ms": BASE_MS + 40000, "commission_usd": "-0.002487", "profit_usd": "-0.0010"},
        ]
        income = [
            _ev("trading_fee", "-0.00248615", BASE_MS + 1000, "F1"),
            _ev("trading_fee", "-0.00248656", BASE_MS + 41000, "F2"),
            _ev("realized_pnl", "-0.00103", BASE_MS + 41000, "P2"),
            # adjacent cycle noise, 8 min away -> must be excluded by time
            _ev("trading_fee", "-0.002490", ADJ_MS, "ADJ1"),
            _ev("realized_pnl", "-0.16146", ADJ_MS, "ADJ2"),
        ]
        r = self.m.cross_check_cycle(legs=legs, income_events=income, symbol="BTC-USDT")
        self.assertEqual(r["status"], "ALIGNED")
        self.assertTrue(r["aligned"])

    def test_sub_precision_pnl_is_aligned_not_ambiguous(self) -> None:
        # order profit rounds a -0.00002 realized pnl to 0.0 (091216 case)
        legs = [
            {"order_update_ms": BASE_MS, "commission_usd": "-0.002395", "profit_usd": "0.0"},
            {"order_update_ms": BASE_MS + 40000, "commission_usd": "-0.002395", "profit_usd": "0.0"},
        ]
        income = [
            _ev("trading_fee", "-0.00239491", BASE_MS + 1000, "F1"),
            _ev("trading_fee", "-0.00239500", BASE_MS + 41000, "F2"),
            _ev("realized_pnl", "-0.00002", BASE_MS + 41000, "P"),  # sub-precision, order shows 0
        ]
        r = self.m.cross_check_cycle(legs=legs, income_events=income, symbol="BTC-USDT")
        self.assertEqual(r["status"], "ALIGNED")

    def test_adjacent_material_pnl_contamination_is_divergent(self) -> None:
        legs = [
            {"order_update_ms": BASE_MS, "commission_usd": "-0.002486", "profit_usd": "0.0"},
            {"order_update_ms": BASE_MS + 40000, "commission_usd": "-0.002487", "profit_usd": "-0.0010"},
        ]
        income = [
            _ev("trading_fee", "-0.00248615", BASE_MS + 1000, "F1"),
            _ev("trading_fee", "-0.00248656", BASE_MS + 41000, "F2"),
            _ev("realized_pnl", "-0.00103", BASE_MS + 41000, "P2"),
            _ev("realized_pnl", "-0.16146", BASE_MS + 30000, "CONTAM"),  # material adjacent pnl IN window
        ]
        r = self.m.cross_check_cycle(legs=legs, income_events=income, symbol="BTC-USDT")
        self.assertEqual(r["status"], "DIVERGENT")


if __name__ == "__main__":
    unittest.main()
