from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "reference_venue_status.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("reference_venue_status", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ReferenceVenueStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = _load_module()

    def test_trading_is_admissible(self) -> None:
        v = self.mod.classify_reference_venue_status("TRADING")
        self.assertTrue(v["admissible"])
        self.assertIsNone(v["reason"])
        self.assertFalse(v["schema_drift"])

    def test_trading_is_case_insensitive(self) -> None:
        self.assertTrue(self.mod.classify_reference_venue_status("trading")["admissible"])

    def test_cancel_only_is_not_admissible(self) -> None:
        v = self.mod.classify_reference_venue_status("CANCEL_ONLY")
        self.assertFalse(v["admissible"])
        self.assertEqual(v["reason"], "reference_venue_not_tradable:CANCEL_ONLY")
        self.assertFalse(v["schema_drift"])

    def test_other_known_non_trading_blocks(self) -> None:
        for status in ("HALT", "BREAK", "POST_TRADING", "DELISTED"):
            v = self.mod.classify_reference_venue_status(status)
            self.assertFalse(v["admissible"], status)
            self.assertEqual(v["reason"], f"reference_venue_not_tradable:{status}")
            self.assertFalse(v["schema_drift"], status)

    def test_unknown_enum_fails_closed_with_schema_drift(self) -> None:
        v = self.mod.classify_reference_venue_status("SOME_NEW_MODE")
        self.assertFalse(v["admissible"])
        self.assertEqual(v["reason"], "reference_venue_status_unknown:SOME_NEW_MODE")
        self.assertTrue(v["schema_drift"])

    def test_unfetched_fails_closed(self) -> None:
        v = self.mod.classify_reference_venue_status(None, fetched=False)
        self.assertFalse(v["admissible"])
        self.assertEqual(v["reason"], "reference_venue_status_unavailable")
        self.assertFalse(v["schema_drift"])

    def test_none_status_even_if_fetched_flag_true_is_unavailable(self) -> None:
        v = self.mod.classify_reference_venue_status(None, fetched=True)
        self.assertFalse(v["admissible"])
        self.assertEqual(v["reason"], "reference_venue_status_unavailable")


if __name__ == "__main__":
    unittest.main()
