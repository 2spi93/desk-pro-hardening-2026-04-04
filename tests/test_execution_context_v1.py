from __future__ import annotations

import unittest

from apps.execution_router.context_v1 import (
    apply_execution_context_to_fill_snapshot,
    build_execution_context,
    build_market_structure_snapshot,
)
from apps.execution_router.optimizer_v3 import apply_order_management_to_live_context, execution_optimizer_allows_trade


class ExecutionContextV1Tests(unittest.TestCase):
    def _candidate(self, **overrides: object) -> dict[str, object]:
        candidate: dict[str, object] = {
            "venue": "bingx",
            "spread_bps": 1.8,
            "available_depth_usd": 16000.0,
            "latency_ms": 64.0,
            "fill_probability": 0.74,
            "freshness_ms": 120.0,
            "depth_imbalance": 0.42,
            "volume_imbalance": 0.36,
            "best_bid": 100.0,
            "best_ask": 100.2,
            "mark_price": 100.1,
            "depth_payload": {
                "bids": [[100.0, 52.0], [99.99, 28.0], [99.98, 22.0]],
                "asks": [[100.2, 30.0], [100.21, 18.0], [100.22, 14.0]],
            },
        }
        candidate.update(overrides)
        return candidate

    def test_market_structure_snapshot_derives_bias_zone_and_profile(self) -> None:
        structure = build_market_structure_snapshot(self._candidate(), side="buy")

        self.assertEqual(structure["bias"]["state"], "bullish")
        self.assertEqual(structure["zone"]["state"], "demand")
        self.assertGreater(structure["volume_profile"]["poc"], 0.0)
        self.assertTrue(structure["volume_profile"]["hvn_zones"])

    def test_execution_context_blocks_stale_high_volatility_setup(self) -> None:
        candidate = self._candidate(
            spread_bps=8.5,
            available_depth_usd=280.0,
            freshness_ms=28_000.0,
            latency_ms=220.0,
            fill_probability=0.32,
            depth_imbalance=0.91,
            volume_imbalance=0.88,
        )
        structure = build_market_structure_snapshot(candidate, side="buy")
        context = build_execution_context(candidate, structure, {"predicted_fill_probability": 0.31}, "buy", 1000.0)

        self.assertTrue(context["no_trade"])
        self.assertLess(context["size_multiplier"], 1.0)
        self.assertIn("stale_liquidity_context", context["no_trade_reasons"])
        self.assertIn("depth_cover_too_thin", context["no_trade_reasons"])
        self.assertEqual(context["fallback_mode"], "rules_only")
        self.assertTrue(context["freeze_learning"])

    def test_apply_execution_context_to_fill_snapshot_boosts_aligned_setup(self) -> None:
        candidate = self._candidate()
        structure = build_market_structure_snapshot(candidate, side="buy")
        context = build_execution_context(candidate, structure, {"predicted_fill_probability": 0.72}, "buy", 1000.0)
        adjusted = apply_execution_context_to_fill_snapshot(
            {
                "fill_score": 0.54,
                "probabilistic_fill_probability": 0.58,
                "effective_fill_probability": 0.56,
                "entry_boost": 0.0,
                "confidence": 0.52,
                "aggressiveness": 0.4,
            },
            context,
            structure,
        )

        self.assertTrue(adjusted["context_applied"])
        self.assertGreater(adjusted["entry_boost"], 0.0)
        self.assertGreater(adjusted["fill_score"], 0.54)
        self.assertEqual(adjusted["context_bias"], "bullish")
        self.assertEqual(adjusted["context_fallback_mode"], "normal")

    def test_low_volatility_context_expands_size_and_boost(self) -> None:
        candidate = self._candidate(
            spread_bps=1.0,
            freshness_ms=60.0,
            latency_ms=45.0,
            depth_imbalance=0.1,
            volume_imbalance=0.08,
            queue_position=0.2,
        )
        structure = build_market_structure_snapshot(candidate, side="buy")
        context = build_execution_context(candidate, structure, {"predicted_fill_probability": 0.81, "queue_edge": 0.76}, "buy", 1000.0)

        self.assertGreater(context["size_multiplier"], 1.0)
        self.assertGreater(context["entry_boost_adjustment"], 0.15)
        self.assertEqual(context["policy"]["learning_mode"], "online")

    def test_no_trade_dominance_blocks_soft_environment_stack(self) -> None:
        candidate = self._candidate(
            spread_bps=3.6,
            latency_ms=110.0,
            fill_probability=0.38,
            depth_imbalance=-0.84,
            volume_imbalance=-0.8,
            queue_position=0.82,
            volatility_regime="high",
        )
        structure = build_market_structure_snapshot(candidate, side="buy")
        context = build_execution_context(candidate, structure, {"predicted_fill_probability": 0.38, "queue_edge": 0.18}, "buy", 1000.0)

        self.assertTrue(context["no_trade"])
        self.assertTrue(context["no_trade_dominance"])
        self.assertEqual(context["no_trade_state"], "dominant_block")
        self.assertIn("dominance_environment_stack", context["no_trade_reasons"])
        self.assertIn("dominance_environment_stack", context["dominant_reasons"])
        self.assertIn("queue_pressure_high", context["dominance_soft_signals"])

    def test_optimizer_allows_trade_respects_context_no_trade(self) -> None:
        snapshot = {
            "slippage_guard": {"allowed": True},
            "order_management": {"action": "keep"},
            "execution_context": {"no_trade": True, "no_trade_reasons": ["context_confidence_below_floor"]},
        }

        self.assertFalse(execution_optimizer_allows_trade(snapshot))

    def test_apply_order_management_to_live_context_respects_context_target_notional(self) -> None:
        adapted = apply_order_management_to_live_context(
            {"order_type": "LIMIT", "price": 100.0, "notional_usd": 1000.0},
            {
                "order_management": {"target_order_type": "LIMIT", "limit_price": 100.1},
                "execution_context": {"target_notional_usd": 420.0},
            },
        )

        self.assertEqual(adapted["notional_usd"], 420.0)
        self.assertEqual(adapted["price"], 100.1)


if __name__ == "__main__":
    unittest.main()