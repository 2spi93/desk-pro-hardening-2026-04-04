from __future__ import annotations

import unittest
from datetime import datetime, timezone

from apps.control_plane import main as control_plane


class ControlPlaneExecutionPnlAnalyzerTests(unittest.TestCase):
    def test_build_execution_pnl_analyzer_groups_and_flags_high_confidence_losses(self) -> None:
        now = datetime(2026, 4, 11, 12, 0, tzinfo=timezone.utc)
        rows = [
            {
                "decision_id": "dec-1",
                "symbol": "BTCUSDT",
                "provider": "bingx",
                "regime": "TREND",
                "score_pre_trade": 0.74,
                "slippage_real_bps": 1.2,
                "latency_ms": 82,
                "fees_usd": 1.4,
                "net_result_usd": 22.5,
                "status": "finalized",
                "created_at": now.isoformat(),
                "route_chosen": "bingx",
                "expected_slippage_bps": 1.0,
                "realized_slippage_bps": 1.2,
                "latency_e2e_ms": 90,
                "payload": {
                    "router_execution": {
                        "execution_mode": "live",
                        "route": {
                            "execution_context": {
                                "confidence": 0.81,
                                "fallback_mode": "normal",
                                "no_trade_dominance": False,
                            }
                        },
                    }
                },
            },
            {
                "decision_id": "dec-2",
                "symbol": "ETHUSDT",
                "provider": "bitget",
                "regime": "CHOP",
                "score_pre_trade": 0.69,
                "slippage_real_bps": 3.8,
                "latency_ms": 128,
                "fees_usd": 1.0,
                "net_result_usd": -18.0,
                "status": "finalized",
                "created_at": now.replace(minute=1).isoformat(),
                "route_chosen": "bitget",
                "expected_slippage_bps": 2.4,
                "realized_slippage_bps": 3.8,
                "latency_e2e_ms": 140,
                "payload": {
                    "router_execution": {
                        "execution_mode": "simulated",
                        "route": {
                            "execution_context": {
                                "confidence": 0.76,
                                "fallback_mode": "degraded",
                                "no_trade_dominance": True,
                                "no_trade_state": "dominant_block",
                                "no_trade_reasons": ["dominance_environment_stack"],
                                "dominant_reasons": ["dominance_environment_stack"],
                            }
                        },
                    }
                },
            },
            {
                "decision_id": "dec-3",
                "symbol": "BTCUSDT",
                "provider": "bingx",
                "regime": "TREND",
                "score_pre_trade": 0.42,
                "slippage_real_bps": 2.0,
                "latency_ms": 96,
                "fees_usd": 1.1,
                "net_result_usd": -4.0,
                "status": "finalized",
                "created_at": now.replace(minute=2).isoformat(),
                "route_chosen": "bingx",
                "expected_slippage_bps": 1.8,
                "realized_slippage_bps": 2.0,
                "latency_e2e_ms": 102,
                "payload": {
                    "router_execution": {
                        "execution_mode": "live",
                        "route": {
                            "execution_context": {
                                "confidence": 0.41,
                                "fallback_mode": "normal",
                                "no_trade_dominance": False,
                            }
                        },
                    }
                },
            },
        ]

        payload = control_plane._build_execution_pnl_analyzer_payload(
            rows,
            scope_type="strategy",
            scope_id="mt5-live",
            start=now,
            end=now,
            confidence_flag_threshold=0.7,
            trade_limit=20,
        )

        self.assertEqual(payload["summary"]["trade_count"], 3)
        self.assertEqual(payload["summary"]["high_confidence_loss_count"], 1)
        self.assertEqual(payload["summary"]["no_trade_dominance_count"], 1)
        self.assertAlmostEqual(payload["summary"]["net_pnl_usd"], 0.5)
        self.assertEqual(len(payload["bad_model_flags"]), 1)
        self.assertEqual(payload["bad_model_flags"][0]["decision_id"], "dec-2")

        by_regime = {row["regime"]: row for row in payload["by_regime"]}
        self.assertIn("TREND", by_regime)
        self.assertIn("CHOP", by_regime)
        self.assertEqual(by_regime["TREND"]["trade_count"], 2)
        self.assertAlmostEqual(by_regime["TREND"]["net_pnl_usd"], 18.5)

        by_execution_mode = {row["execution_mode"]: row for row in payload["by_execution_mode"]}
        self.assertEqual(by_execution_mode["live"]["trade_count"], 2)
        self.assertEqual(by_execution_mode["simulated"]["high_confidence_losses"], 1)

    def test_build_ops_copilot_desk_brief_summarizes_live_truth(self) -> None:
        payload = control_plane._build_ops_copilot_desk_brief(
            pnl_payload={
                "summary": {
                    "trade_count": 6,
                    "net_pnl_usd": -9.5,
                    "avg_pnl_usd": -1.58,
                    "win_rate_pct": 33.3,
                    "avg_latency_ms": 128,
                    "avg_slippage_bps": 3.4,
                    "high_confidence_loss_count": 1,
                    "no_trade_dominance_count": 0,
                }
            },
            readiness_payload={
                "drift": {
                    "suspended_strategies": [
                        {"strategy_id": "trend-v6"},
                    ]
                }
            },
            incidents_payload={"items": [{"ticket_key": "INC-1"}]},
            strategies_payload=[
                {"strategy_id": "trend-v6", "current_level": 2, "status": "shadow", "updated_at": "2026-04-11T12:00:00+00:00"},
            ],
            execution_ai_v6_payload={
                "snapshot": {
                    "reward_ema": -0.21,
                    "guardrails": {
                        "learning_frozen": True,
                    },
                }
            },
        )

        self.assertEqual(payload["status"], "ok")
        self.assertIn("Desk truth BLOCK", payload["reply"])
        self.assertIn("Calibration semi-auto", payload["reply"])
        self.assertIn("open_live_ops", payload["actions"])
        self.assertIn("open_terminal_truth", payload["actions"])

    def test_build_ops_copilot_command_brief_returns_directive_decision(self) -> None:
        payload = control_plane._build_ops_copilot_command_brief(
            pnl_payload={
                "summary": {
                    "trade_count": 6,
                    "net_pnl_usd": -11.0,
                    "avg_latency_ms": 146,
                    "avg_slippage_bps": 3.9,
                    "win_rate_pct": 33.0,
                    "high_confidence_loss_count": 2,
                    "no_trade_dominance_count": 4,
                },
                "trades": [
                    {"net_result_usd": -6.0},
                    {"net_result_usd": -2.0},
                ],
            },
            readiness_payload={"drift": {"suspended_strategies": []}},
            incidents_payload={"items": []},
            strategies_payload=[],
            execution_ai_v6_payload={"snapshot": {"guardrails": {"persistence_available": True, "learning_frozen": False}}},
        )

        self.assertEqual(payload["status"], "ok")
        self.assertIn("DECISION: STOP", payload["reply"])
        self.assertIn("RISQUE: eleve", payload["reply"])
        self.assertIn("OVERRIDE: possible mais visible", payload["reply"])


if __name__ == "__main__":
    unittest.main()