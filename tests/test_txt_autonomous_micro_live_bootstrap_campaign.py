from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_autonomous_micro_live_bootstrap_campaign.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_autonomous_micro_live_bootstrap_campaign", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _reports(*, used: float = 0.0, incident_blocker: bool = False) -> dict:
    blockers = ["promotion_relevant_incidents_present"] if incident_blocker else []
    return {
        "promotion_gate": {
            "PROOF_LAYER_VALIDATED": True,
            "BLOCKERS": blockers,
            "runtime": {
                "daily_notional_used_usd": used,
                "daily_notional_limit_usd": 30.0,
            },
        },
        "certified_outcomes": {
            "scanner": {"certified_outcomes": {"certified_total": 3, "required_total": 100}},
            "projection": {"certified_total": 3},
        },
        "bootstrap_policy": {
            "bootstrap_analysis": {"proof_gate_usable_before_threshold": True},
        },
    }


def _signal(side: str = "buy") -> dict:
    return {
        "signal_id": "sig-1",
        "admissible": True,
        "symbol": "BTCUSDT",
        "side": side,
        "edge_score": 0.12,
    }


class TxtAutonomousMicroLiveBootstrapCampaignTests(unittest.TestCase):
    def test_authorizes_one_cycle_only_when_contract_and_signal_are_clean(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0),
            strategy_signal=_signal("sell"),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertTrue(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertEqual(report["NEXT_ACTION"], "execute_one_micro_cycle")
        self.assertEqual(report["NEXT_SIDE"], "sell")
        self.assertEqual(report["current_state"]["available_cycles_today"], 2)
        self.assertEqual(report["BLOCKERS"], [])

    def test_missing_expiry_and_authorization_block_campaign(self) -> None:
        mod = _load_module()

        report = mod.build_review(
            contract=mod.CampaignContract(),
            reports=_reports(used=0.0),
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("campaign_expiry_required", report["BLOCKERS"])
        self.assertIn("operator_authorization_missing", report["BLOCKERS"])

    def test_budget_exhaustion_blocks_without_invalidating_proof(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=30.0),
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("budget_exhausted", report["BLOCKERS"])
        self.assertTrue(report["current_state"]["proof_layer_validated"])

    def test_strategy_signal_must_be_admissible_real_edge(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )
        signal = {"admissible": True, "symbol": "BTCUSDT", "side": "buy", "edge_score": 0}

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0),
            strategy_signal=signal,
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("strategy_signal_edge_not_positive", ",".join(report["BLOCKERS"]))

    def test_promotion_relevant_incident_blocks_campaign(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0, incident_blocker=True),
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("promotion_relevant_incident", report["BLOCKERS"])


if __name__ == "__main__":
    unittest.main()
