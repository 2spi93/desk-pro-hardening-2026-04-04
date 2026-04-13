from __future__ import annotations

import unittest

from apps.execution_router.main import (
    EXECUTION_AI_V6_STATE,
    _compute_execution_ai_v6_reward,
    _execution_ai_v6_decide,
    _execution_ai_v6_guardrails,
    _execution_ai_v6_learn,
    _rebuild_execution_ai_v6_state_from_episodes,
)


def _reset_execution_ai_v6_state() -> None:
    EXECUTION_AI_V6_STATE.clear()
    EXECUTION_AI_V6_STATE.update(
        {
            "episodes": [],
            "actions": {},
            "contexts": {},
            "reward_ema": 0.0,
            "reward_peak": 0.0,
            "reward_drawdown": 0.0,
            "reward_volatility": 0.0,
            "negative_streak": 0,
            "learning_frozen": False,
            "freeze_reasons": [],
            "loaded": True,
            "loaded_at": None,
            "updated_at": None,
        }
    )


class ExecutionRouterV6Tests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_execution_ai_v6_state()

    def _state(self, **overrides: object) -> dict[str, object]:
        state: dict[str, object] = {
            "side": "buy",
            "notional_usd": 5000.0,
            "venue": "okx",
            "backup_venue": "binance",
            "fill_probability": 0.82,
            "dominance_score": 0.79,
            "route_score": 0.77,
            "backup_score": 0.66,
            "queue_position": 0.21,
            "spread_bps": 1.2,
            "slippage_cost_bps": 1.8,
            "latency_ms": 28.0,
            "flow_intensity": 12000.0,
            "available_depth_usd": 18000.0,
            "liquidity_pressure": 0.28,
            "depth_imbalance": 0.06,
            "volume_imbalance": 0.1,
            "split_mode": "singleVenue",
            "split_coverage": 0.0,
            "split_venue_count": 1,
            "arbitrage_executable": False,
            "arb_net_spread_bps": 0.0,
            "hedge_mode": "standby",
            "execution_style": "default",
            "market_regime": "dominant",
        }
        state.update(overrides)
        return state

    def test_reward_model_scores_clean_fill_positive(self) -> None:
        reward = _compute_execution_ai_v6_reward(
            self._state(split_mode="multiVenueSplit"),
            action="split_ioc",
            requested_notional_usd=5000.0,
            filled_notional_usd=5000.0,
            realized_slippage_bps=0.9,
            fill_latency_ms=18.0,
            adverse_selection_score=0.04,
            edge_bps=3.0,
        )

        self.assertGreater(reward["reward"], 10.0)
        self.assertAlmostEqual(reward["fill_ratio"], 1.0, places=6)
        self.assertGreater(reward["split_bonus"], 0.0)

    def test_decision_prefers_split_ioc_for_multi_venue_arb(self) -> None:
        decision = _execution_ai_v6_decide(
            self._state(
                split_mode="multiVenueSplit",
                split_coverage=0.98,
                split_venue_count=3,
                arbitrage_executable=True,
                arb_net_spread_bps=14.0,
                market_regime="arb",
                fill_probability=0.76,
            )
        )

        self.assertEqual(decision["action"], "split_ioc")
        self.assertTrue(decision["should_execute"])
        self.assertGreater(decision["projected_reward"], 0.0)

    def test_learning_bias_promotes_profitable_action(self) -> None:
        state = self._state()
        for _ in range(4):
            _execution_ai_v6_learn(
                state,
                {"action": "join_best_limit"},
                requested_notional_usd=5000.0,
                filled_notional_usd=5000.0,
                realized_slippage_bps=0.8,
                fill_latency_ms=20.0,
                adverse_selection_score=0.05,
                edge_bps=2.8,
            )

        decision = _execution_ai_v6_decide(state)

        self.assertEqual(decision["learned_bias"]["action"], "join_best_limit")
        self.assertGreaterEqual(decision["learned_bias"]["sample_count"], 4)
        self.assertEqual(decision["action"], "join_best_limit")

    def test_guardrails_freeze_after_negative_streak(self) -> None:
        state = self._state(
            fill_probability=0.2,
            dominance_score=0.12,
            slippage_cost_bps=9.0,
            latency_ms=120.0,
            liquidity_pressure=0.92,
            market_regime="stressed",
        )
        for _ in range(4):
            _execution_ai_v6_learn(
                state,
                {"action": "market_sweep"},
                requested_notional_usd=5000.0,
                filled_notional_usd=900.0,
                realized_slippage_bps=18.0,
                fill_latency_ms=260.0,
                adverse_selection_score=0.9,
                edge_bps=-6.0,
            )

        guardrails = _execution_ai_v6_guardrails()

        self.assertTrue(guardrails["learning_frozen"])
        self.assertIn("negative_streak_limit", guardrails["freeze_reasons"])

    def test_rebuild_runtime_state_from_persisted_episodes(self) -> None:
        episodes = [
            {
                "decision_id": "persist-a",
                "timestamp": "2026-04-10T10:00:00+00:00",
                "context_key": "dominant|singleVenue|front|normal|okx",
                "state": self._state(),
                "action": "join_best_limit",
                "reward": 9.5,
                "learning_applied": True,
                "reward_components": {"reward": 9.5},
            },
            {
                "decision_id": "persist-b",
                "timestamp": "2026-04-10T10:01:00+00:00",
                "context_key": "dominant|singleVenue|front|normal|okx",
                "state": self._state(),
                "action": "join_best_limit",
                "reward": 7.2,
                "learning_applied": True,
                "reward_components": {"reward": 7.2},
            },
        ]

        _rebuild_execution_ai_v6_state_from_episodes(episodes)
        decision = _execution_ai_v6_decide(self._state())
        guardrails = _execution_ai_v6_guardrails()

        self.assertTrue(guardrails["loaded"])
        self.assertEqual(decision["learned_bias"]["action"], "join_best_limit")
        self.assertGreaterEqual(decision["learned_bias"]["sample_count"], 2)

    def test_policy_freeze_learning_skips_bucket_updates(self) -> None:
        state = self._state()
        result = _execution_ai_v6_learn(
            state,
            {"action": "join_best_limit"},
            requested_notional_usd=5000.0,
            filled_notional_usd=5000.0,
            realized_slippage_bps=0.9,
            fill_latency_ms=22.0,
            adverse_selection_score=0.08,
            edge_bps=2.5,
            policy_context={"freeze_learning": True, "freeze_learning_reasons": ["fallback_rules_only"]},
        )

        self.assertTrue(result["policy_freeze_learning"])
        self.assertFalse(result["learning_applied"])
        self.assertEqual(EXECUTION_AI_V6_STATE["actions"], {})


if __name__ == "__main__":
    unittest.main()