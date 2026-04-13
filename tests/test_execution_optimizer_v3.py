from __future__ import annotations

import unittest

from apps.execution_router.optimizer_v3 import build_execution_optimizer_snapshot, compute_queue_edge, execution_optimizer_allows_trade


class ExecutionOptimizerV3Tests(unittest.TestCase):
    def _candidate(self, **overrides: object) -> dict[str, object]:
        candidate: dict[str, object] = {
            "venue": "bybit",
            "spread_bps": 2.2,
            "available_depth_usd": 2500.0,
            "latency_ms": 34.0,
            "fill_probability": 0.74,
            "freshness_ms": 1200.0,
            "queue_priority_bias": 0.82,
            "incoming_flow_usd_per_min": 4200.0,
            "tape_acceleration": 0.32,
            "depth_imbalance": 0.08,
            "volume_imbalance": 0.12,
            "best_bid": 100.0,
            "best_ask": 100.1,
            "last": 100.05,
            "mark_price": 100.05,
            "depth_payload": {
                "bids": [[100.0, 8.0], [99.99, 5.0], [99.98, 4.0]],
                "asks": [[100.1, 7.0], [100.11, 4.0], [100.12, 3.0]],
            },
        }
        candidate.update(overrides)
        return candidate

    def test_queue_edge_improves_when_flow_outpaces_queue(self) -> None:
        low_edge = compute_queue_edge(self._candidate(incoming_flow_usd_per_min=400.0), "buy", 100.0)
        high_edge = compute_queue_edge(self._candidate(incoming_flow_usd_per_min=4200.0), "buy", 100.0)

        self.assertLess(low_edge["queue_edge"], high_edge["queue_edge"])
        self.assertGreater(high_edge["queue_edge"], 0.7)

    def test_slippage_guard_blocks_thin_and_unstable_candidate(self) -> None:
        snapshot = build_execution_optimizer_snapshot(
            self._candidate(
                spread_bps=16.0,
                available_depth_usd=90.0,
                latency_ms=420.0,
                fill_probability=0.31,
                freshness_ms=72000.0,
                depth_imbalance=0.95,
                volume_imbalance=0.9,
                incoming_flow_usd_per_min=55.0,
            ),
            "buy",
            100.0,
            "default",
            "MARKET",
        )

        self.assertFalse(execution_optimizer_allows_trade(snapshot))
        self.assertIn("spread_too_wide", snapshot["slippage_guard"]["reasons"])
        self.assertIn("fill_probability_below_0_5", snapshot["slippage_guard"]["reasons"])
        self.assertEqual(snapshot["order_management"]["action"], "cancel")

    def test_passive_execution_replaces_market_with_limit_join(self) -> None:
        snapshot = build_execution_optimizer_snapshot(
            self._candidate(),
            "buy",
            80.0,
            "maker_passive",
            "MARKET",
        )

        self.assertTrue(execution_optimizer_allows_trade(snapshot))
        self.assertEqual(snapshot["order_management"]["action"], "replace")
        self.assertEqual(snapshot["order_management"]["target_order_type"], "LIMIT")
        self.assertEqual(snapshot["order_management"]["fill_band"], "execute")
        self.assertAlmostEqual(snapshot["order_management"]["limit_price"], 100.0)

    def test_strong_candidate_keeps_existing_limit_order(self) -> None:
        snapshot = build_execution_optimizer_snapshot(
            self._candidate(),
            "buy",
            80.0,
            "default",
            "LIMIT",
            live_limit_price=100.06,
        )

        self.assertTrue(execution_optimizer_allows_trade(snapshot))
        self.assertGreaterEqual(snapshot["predicted_fill_probability"], 0.7)
        self.assertEqual(snapshot["order_management"]["action"], "keep")


if __name__ == "__main__":
    unittest.main()