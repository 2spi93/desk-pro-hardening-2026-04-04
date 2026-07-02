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


def _reports(*, used: float = 0.0, incident_blocker: bool = False, promotion_blockers: list[str] | None = None) -> dict:
    blockers = list(promotion_blockers or [])
    if incident_blocker:
        blockers.append("promotion_relevant_incidents_present")
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
        "opportunity_gate": {
            "OPPORTUNITY_GATE_READY": True,
            "lock": {"active": False},
            "incident_adjudication": {"promotion_relevant_incident_clear": True},
        },
        "incident_adjudication": {
            "promotion_relevant_blockers": 0,
        },
    }


def _signal(side: str = "buy") -> dict:
    return {
        "schema_version": "txt.strategy-signal.v1",
        "signal_id": "sig-1",
        "strategy_id": "bootstrap-edge-smoke",
        "strategy_version": "v1",
        "symbol": "BTCUSDT",
        "side": side,
        "generated_at": "2026-06-29T11:55:00Z",
        "expires_at": "2026-06-29T12:05:00Z",
        "confidence": 0.72,
        "market_regime": "liquid_micro",
        "entry_reason": "positive_micro_edge_after_costs",
        "invalidation_reason": "spread_or_consistency_degrades",
        "expected_edge_bps": 4.0,
        "estimated_fees_bps": 1.2,
        "estimated_slippage_bps": 1.0,
        "net_expected_edge_bps": 1.8,
        "consumed": False,
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
        self.assertEqual(report["NEXT_ACTION"], "await_operator_authorization")
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

    def test_strategy_signal_must_have_positive_net_edge_after_costs(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )
        signal = _signal()
        signal["net_expected_edge_bps"] = 0

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0),
            strategy_signal=signal,
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("strategy_signal_net_edge_not_positive", ",".join(report["BLOCKERS"]))

    def test_strategy_signal_expires_and_cannot_be_reused(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )

        expired = _signal()
        expired["expires_at"] = "2026-06-29T11:59:00Z"
        expired_report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0),
            strategy_signal=expired,
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )
        self.assertIn("strategy_signal_expired", ",".join(expired_report["BLOCKERS"]))

        reused_report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0),
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
            consumed_signal_ids={"sig-1"},
        )
        self.assertIn("strategy_signal_already_consumed", ",".join(reused_report["BLOCKERS"]))

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

    def test_certified_outcomes_threshold_incident_does_not_block_bootstrap(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )
        reports = _reports(used=0.0, incident_blocker=True)
        reports["certified_outcomes"]["verdict"] = "E_CERTIFIED_OUTCOMES_THRESHOLD_NOT_REACHED"
        reports["incident_adjudication"] = {"promotion_relevant_blockers": 1}

        report = mod.build_review(
            contract=contract,
            reports=reports,
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertTrue(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertNotIn("promotion_relevant_incident", report["BLOCKERS"])

    def test_additional_promotion_incident_still_blocks_bootstrap(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )
        reports = _reports(used=0.0, incident_blocker=True)
        reports["certified_outcomes"]["verdict"] = "E_CERTIFIED_OUTCOMES_THRESHOLD_NOT_REACHED"
        reports["incident_adjudication"] = {"promotion_relevant_blockers": 2}

        report = mod.build_review(
            contract=contract,
            reports=reports,
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("promotion_relevant_incident", report["BLOCKERS"])

    def test_opportunity_gate_review_blocks_campaign_when_not_ready(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )
        reports = _reports(used=0.0)
        reports["opportunity_gate"] = {
            "OPPORTUNITY_GATE_READY": False,
            "lock": {"active": True, "owner": "opportunity_gate", "reason": "consistency_kill_threshold"},
        }

        report = mod.build_review(
            contract=contract,
            reports=reports,
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("opportunity_gate_not_ready", report["BLOCKERS"])

    def test_stale_proof_blocks_normal_autonomous_campaign(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
        )

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0, promotion_blockers=["latest_proof_not_fresh"]),
            strategy_signal=_signal(),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertFalse(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertIn("promotion_gate_latest_proof_not_fresh", report["BLOCKERS"])

    def test_stale_proof_is_allowed_only_for_dedicated_renewal_canary(self) -> None:
        mod = _load_module()
        contract = mod.CampaignContract(
            campaign_expiry="2026-06-30T00:00:00Z",
            operator_authorization=mod.CAMPAIGN_AUTH_TOKEN,
            proof_renewal_canary=True,
        )

        report = mod.build_review(
            contract=contract,
            reports=_reports(used=0.0, promotion_blockers=["latest_proof_not_fresh"]),
            strategy_signal=_signal("buy"),
            now=datetime(2026, 6, 29, 12, 0, tzinfo=timezone.utc),
        )

        self.assertTrue(report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"])
        self.assertEqual(report["NEXT_SIDE"], "buy")
        self.assertNotIn("promotion_gate_latest_proof_not_fresh", report["BLOCKERS"])
        self.assertEqual(report["proof_renewal_canary"]["stale_proof_is_allowed_reason"], "renewal_target")


if __name__ == "__main__":
    unittest.main()
