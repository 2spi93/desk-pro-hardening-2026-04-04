from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_sell_canary_autoexec_oneshot.py"


def _load():
    spec = importlib.util.spec_from_file_location("txt_sell_canary_autoexec_oneshot", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


NOW = datetime(2026, 7, 8, 21, 0, 0, tzinfo=timezone.utc)


def _alert(side: str, status: str, secs: float, net: float = 6.0) -> dict:
    return {
        "status": status,
        "side": side,
        "expires_at": (NOW + timedelta(seconds=secs)).isoformat(),
        "episode_key": f"{side}-k",
        "net_expected_edge_bps": net,
    }


class SellCanaryAutoexecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_fresh_sell_with_margin_detected(self) -> None:
        v = self.m.evaluate_fresh_sell(_alert("sell", "FRESH_SHADOW_EPISODE", 200), NOW, 90)
        self.assertIsNotNone(v)
        self.assertTrue(v["edge_positive"])

    def test_below_margin_rejected(self) -> None:
        self.assertIsNone(self.m.evaluate_fresh_sell(_alert("sell", "FRESH_SHADOW_EPISODE", 60), NOW, 90))

    def test_buy_ignored(self) -> None:
        self.assertIsNone(self.m.evaluate_fresh_sell(_alert("buy", "FRESH_SHADOW_EPISODE", 200), NOW, 90))

    def test_expired_status_ignored(self) -> None:
        self.assertIsNone(self.m.evaluate_fresh_sell(_alert("sell", "EXPIRED", 200), NOW, 90))

    def test_already_expired_time_ignored(self) -> None:
        self.assertIsNone(self.m.evaluate_fresh_sell(_alert("sell", "FRESH_SHADOW_EPISODE", -5), NOW, 90))

    def test_preflight_green_all_ok(self) -> None:
        green, reasons = self.m.preflight_green(
            {"edge_positive": True, "net_bps": 6.0},
            {"ready_for_dedicated_go": True, "reference_venue_status": {"admissible": True, "status": "TRADING"}},
        )
        self.assertTrue(green)
        self.assertEqual(reasons, [])

    def test_preflight_blocks_on_negative_edge(self) -> None:
        green, reasons = self.m.preflight_green(
            {"edge_positive": False},
            {"ready_for_dedicated_go": True, "reference_venue_status": {"admissible": True, "status": "TRADING"}},
        )
        self.assertFalse(green)
        self.assertIn("edge_net_not_positive", reasons)

    def test_preflight_blocks_on_cancel_only_and_not_ready(self) -> None:
        green, reasons = self.m.preflight_green(
            {"edge_positive": True, "net_bps": 6.0},
            {"ready_for_dedicated_go": False, "reasons": ["not_flat"], "reference_venue_status": {"admissible": False, "status": "CANCEL_ONLY"}},
        )
        self.assertFalse(green)
        self.assertIn("binance_reference_not_trading", reasons)
        self.assertIn("readiness:not_flat", reasons)

    def test_consumed_marker_constant_paths_are_distinct(self) -> None:
        # the one-shot safety hinges on these two markers being distinct files
        self.assertNotEqual(self.m.ARM_MARKER, self.m.CONSUMED_MARKER)
        self.assertEqual(self.m.CONFIRM_TOKEN, "PROOF_RENEWAL_EXECUTE")
        self.assertEqual(self.m.GO_PHRASE, "GO renew BingX autonomous proof side=sell")


if __name__ == "__main__":
    unittest.main()
