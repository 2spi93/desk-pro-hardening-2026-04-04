from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "bingx_proof_promotion_gate_review.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bingx_proof_promotion_gate_review", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _payload() -> dict:
    roots = [
        ("proofcyc-20260629T090000Z", "sell", "buy"),
        ("proofcyc-20260629T091000Z", "sell", "buy"),
        ("proofcyc-20260629T092000Z", "buy", "sell"),
    ]
    fills = []
    outcomes = []
    gaps = []
    for root, entry_side, exit_side in roots:
        fills.extend(
            [
                {
                    "decision_id": f"{root}-entry",
                    "fill_id": f"{root}-f1",
                    "venue": "bingx",
                    "instrument": "BTCUSDT",
                    "side": entry_side,
                    "notional_usd": 6,
                    "fill_type": "live-broker",
                    "filled_at": "2026-06-29T09:20:00+00:00",
                },
                {
                    "decision_id": f"{root}-exit",
                    "fill_id": f"{root}-f2",
                    "venue": "bingx",
                    "instrument": "BTCUSDT",
                    "side": exit_side,
                    "notional_usd": 6,
                    "fill_type": "live-broker",
                    "filled_at": "2026-06-29T09:21:00+00:00",
                },
            ]
        )
        outcomes.append(
            {
                "decision_id": f"{root}-entry",
                "source": "intent",
                "provider": "bingx",
                "status": "finalized",
                "updated_at": "2026-06-29T09:22:00+00:00",
            }
        )
        gaps.append(
            {
                "sample_id": f"rg-{root}",
                "decision_id": f"{root}-entry",
                "venue": "bingx",
                "side": entry_side,
                "created_at": "2026-06-29T09:23:00+00:00",
                "failure_source": None,
            }
        )
    return {"fills": fills, "outcomes": outcomes, "gaps": gaps, "incidents": []}


def _runtime(**overrides) -> dict:
    base = {
        "control_plane": "ok",
        "system_mode": "guarded_auto",
        "gate": "go",
        "kill_recommended": False,
        "pending_intents": 0,
        "local_lock_active": False,
        "risk_gateway": "ok",
        "daily_notional_used_usd": 15.0,
        "daily_notional_limit_usd": 30.0,
    }
    base.update(overrides)
    return base


def _readiness() -> dict:
    return {
        "ready_for_dedicated_go": True,
        "no_market_action": True,
        "state": {"open_positions": 0, "open_orders": 0},
    }


class BingxProofPromotionGateReviewTests(unittest.TestCase):
    def test_promotable_when_three_clean_cycles_cover_buy_and_sell(self) -> None:
        mod = _load_module()

        review = mod.build_review(
            _payload(),
            runtime=_runtime(),
            readiness=_readiness(),
            rail={"rail_separation": "PASS"},
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertTrue(review["PROOF_LAYER_VALIDATED"])
        self.assertTrue(review["PROMOTABLE_TO_MICRO_LIVE"])
        self.assertEqual(review["BLOCKERS"], [])
        self.assertEqual(review["MAX_NOTIONAL"], 7.5)
        self.assertEqual(review["MAX_CYCLES_PER_DAY"], 1)

    def test_budget_saturation_blocks_promotion_without_invalidating_proof(self) -> None:
        mod = _load_module()

        review = mod.build_review(
            _payload(),
            runtime=_runtime(daily_notional_used_usd=30.0),
            readiness=_readiness(),
            rail={"rail_separation": "PASS"},
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertTrue(review["PROOF_LAYER_VALIDATED"])
        self.assertFalse(review["PROMOTABLE_TO_MICRO_LIVE"])
        self.assertIn("risk_budget_not_available_today", review["BLOCKERS"])

    def test_missing_buy_branch_blocks_proof_layer_validation(self) -> None:
        mod = _load_module()
        payload = _payload()
        for row in payload["fills"]:
            if str(row["decision_id"]).endswith("-entry"):
                row["side"] = "sell"
            else:
                row["side"] = "buy"

        review = mod.build_review(
            payload,
            runtime=_runtime(),
            readiness=_readiness(),
            rail={"rail_separation": "PASS"},
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertFalse(review["PROOF_LAYER_VALIDATED"])
        self.assertFalse(review["PROMOTABLE_TO_MICRO_LIVE"])
        self.assertIn("buy_and_sell_not_both_covered", review["BLOCKERS"])

    def test_only_promotion_relevant_incidents_block_promotion(self) -> None:
        mod = _load_module()
        payload = _payload()
        payload["incidents"] = [
            {
                "ticket_key": "INC-old-terminal-1",
                "severity": "critical",
                "status": "open",
                "source": "ops-chatbot",
                "title": "Terminal local hard fail BTCUSDT 1h",
                "payload": {},
                "created_at": "2026-05-20T10:00:00+00:00",
            },
            {
                "ticket_key": "INC-old-terminal-2",
                "severity": "critical",
                "status": "open",
                "source": "ops-chatbot",
                "title": "Terminal local hard fail BTCUSDT 5m",
                "payload": {},
                "created_at": "2026-05-20T10:00:00+00:00",
            },
        ]

        review = mod.build_review(
            payload,
            runtime=_runtime(),
            readiness=_readiness(),
            rail={"rail_separation": "PASS"},
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertTrue(review["PROMOTABLE_TO_MICRO_LIVE"])
        self.assertNotIn("promotion_relevant_incidents_present", review["BLOCKERS"])
        self.assertEqual(review["counts"]["promotion_relevant_incident_blockers"], 0)

        payload["incidents"].append(
            {
                "ticket_key": "INC-constitutional",
                "severity": "critical",
                "status": "open",
                "source": "ops-chatbot",
                "title": "[Constitutional] Certified Outcomes Gate blocked",
                "payload": {"detail": "live promotion remains blocked"},
                "created_at": "2026-06-29T09:00:00+00:00",
            }
        )

        blocked = mod.build_review(
            payload,
            runtime=_runtime(),
            readiness=_readiness(),
            rail={"rail_separation": "PASS"},
            now=mod.parse_time("2026-06-29T10:00:00+00:00"),
        )

        self.assertFalse(blocked["PROMOTABLE_TO_MICRO_LIVE"])
        self.assertIn("promotion_relevant_incidents_present", blocked["BLOCKERS"])
        self.assertEqual(blocked["counts"]["promotion_relevant_incident_blockers"], 1)


if __name__ == "__main__":
    unittest.main()
