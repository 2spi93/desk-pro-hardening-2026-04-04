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


class ArmExpiryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        # redirect markers/artifacts to a temp dir so no real marker is touched
        self.m.OUT_DIR = d
        self.m.ARM_MARKER = d / "sell_canary_autoexec.ARMED"
        self.m.CONSUMED_MARKER = d / "sell_canary_autoexec.CONSUMED"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _arm(self, secs_from_now: float | None) -> None:
        import json as _json

        payload = {"scope": "one_sell_cycle"}
        if secs_from_now is not None:
            # relative to REAL now, since _arm_expires_at/_now use wall clock
            expiry = datetime.now(timezone.utc) + timedelta(seconds=secs_from_now)
            payload["arm_expires_at"] = expiry.isoformat()
        self.m.ARM_MARKER.write_text(_json.dumps(payload), encoding="utf-8")

    def test_arm_expires_at_parses(self) -> None:
        self._arm(3600)
        exp = self.m._arm_expires_at()
        self.assertIsNotNone(exp)

    def test_missing_expiry_returns_none(self) -> None:
        self._arm(None)
        self.assertIsNone(self.m._arm_expires_at())

    def test_expired_when_past(self) -> None:
        self._arm(-60)
        exp = self.m._arm_expires_at()
        self.assertTrue(exp is not None and self.m._now() >= exp)

    def test_not_expired_when_future(self) -> None:
        self._arm(3600)
        exp = self.m._arm_expires_at()
        self.assertTrue(exp is not None and self.m._now() < exp)

    def test_write_outcome_is_durable_artifact(self) -> None:
        import json as _json

        self._arm(3600)
        path = self.m._write_outcome("ARM_EXPIRED", NOW, no_order=True)
        self.assertTrue(path.exists())
        data = _json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["result"], "ARM_EXPIRED")
        self.assertTrue(data["no_order"])
        self.assertEqual(data["schema"], "txt.sell-canary-autoexec-outcome.v1")


if __name__ == "__main__":
    unittest.main()
