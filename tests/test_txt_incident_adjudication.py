from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_incident_adjudication.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_incident_adjudication", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _runtime() -> dict:
    return {
        "control_plane": "ok",
        "system_mode": "guarded_auto",
        "gate": "go",
        "kill_recommended": False,
        "pending_intents": 0,
    }


class TxtIncidentAdjudicationTests(unittest.TestCase):
    def test_certified_outcomes_gate_remains_active_confirmed(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-1",
                        "severity": "critical",
                        "status": "open",
                        "source": "ops-chatbot",
                        "title": "[Constitutional] Certified Outcomes Gate blocked",
                        "payload": {"detail": "live promotion remains blocked"},
                        "created_at": "2026-06-29T09:00:00+00:00",
                    }
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual(report["items"][0]["classification"], mod.ACTIVE_CONFIRMED)
        self.assertEqual(report["promotion_relevant_blockers"], 1)
        self.assertFalse(report["PROMOTION_INCIDENT_BLOCK_CLEAR"])

    def test_opportunity_gate_freeze_is_resolved_but_unclosed_when_runtime_clear(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-2",
                        "severity": "critical",
                        "status": "assigned",
                        "source": "opportunity_gate",
                        "title": "Freeze runtime: deviation_kill_threshold",
                        "payload": {},
                        "created_at": "2026-05-21T10:00:00+00:00",
                    }
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual(report["items"][0]["classification"], mod.RESOLVED_BUT_UNCLOSED)
        self.assertEqual(report["promotion_relevant_blockers"], 0)

    def test_old_terminal_family_duplicates_are_stale_duplicates(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-3",
                        "severity": "critical",
                        "status": "open",
                        "source": "ops-chatbot",
                        "title": "Terminal local hard fail BTCUSDT 1h",
                        "payload": {},
                        "created_at": "2026-05-20T10:00:00+00:00",
                    },
                    {
                        "ticket_key": "INC-4",
                        "severity": "critical",
                        "status": "open",
                        "source": "ops-chatbot",
                        "title": "Terminal local hard fail BTCUSDT 5m",
                        "payload": {},
                        "created_at": "2026-05-20T10:00:00+00:00",
                    },
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual({item["classification"] for item in report["items"]}, {mod.STALE_DUPLICATE})
        self.assertTrue(all(not item["relevant_to_execution_router"] for item in report["items"]))

    def test_old_non_execution_incident_is_unrelated(self) -> None:
        mod = _load_module()
        report = mod.build_report(
            {
                "runtime": _runtime(),
                "incidents": [
                    {
                        "ticket_key": "INC-5",
                        "severity": "high",
                        "status": "open",
                        "source": "ui",
                        "title": "Dashboard widget failed",
                        "payload": {},
                        "created_at": "2026-05-20T10:00:00+00:00",
                    }
                ],
            },
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertEqual(report["items"][0]["classification"], mod.UNRELATED_TO_EXECUTION_ROUTER)
        self.assertTrue(report["PROMOTION_INCIDENT_BLOCK_CLEAR"])


if __name__ == "__main__":
    unittest.main()
