from __future__ import annotations

import unittest

from apps.execution_router.main import (
    _annotate_multi_venue_dominance,
    _build_hedge_recommendation,
    _build_multi_venue_split_plan,
    _build_route_context,
    _rank_route_candidates,
)


class ExecutionRouterV5Tests(unittest.TestCase):
    def _candidate(self, venue: str, **overrides: object) -> dict[str, object]:
        candidate: dict[str, object] = {
            "venue": venue,
            "instrument": "BTCUSDT",
            "spread_bps": 1.2,
            "available_depth_usd": 18000.0,
            "depth_confidence": 0.92,
            "best_bid": 100.0,
            "best_ask": 100.1,
            "last": 100.05,
            "latency_ms": 45.0,
            "queue_priority_risk": 0.24,
            "partial_fill_risk": 0.16,
            "fill_probability": 0.74,
            "raw_score": 0.61,
            "score": 0.58,
            "stability_score": 0.9,
            "stability_penalty": 0.04,
            "freshness_ms": 120.0,
            "depth_payload": {
                "bids": [[100.0, 70.0], [99.99, 30.0]],
                "asks": [[100.1, 66.0], [100.11, 28.0]],
            },
        }
        candidate.update(overrides)
        return candidate

    def test_queue_aware_ranking_prefers_fast_fill_over_tighter_spread(self) -> None:
        candidates = _annotate_multi_venue_dominance(
            [
                self._candidate(
                    "binance",
                    best_bid=100.02,
                    best_ask=100.03,
                    spread_bps=0.7,
                    latency_ms=155.0,
                    queue_priority_risk=0.88,
                    partial_fill_risk=0.42,
                    fill_probability=0.46,
                    available_depth_usd=26000.0,
                    score=0.56,
                ),
                self._candidate(
                    "okx",
                    best_bid=100.0,
                    best_ask=100.05,
                    spread_bps=1.4,
                    latency_ms=26.0,
                    queue_priority_risk=0.12,
                    partial_fill_risk=0.1,
                    fill_probability=0.84,
                    available_depth_usd=15000.0,
                    score=0.52,
                ),
            ]
        )

        ranked = _rank_route_candidates(
            candidates,
            "buy",
            {"preferred_venue": "", "route_mode_override": "", "execution_style": "default"},
        )

        self.assertEqual(ranked[0]["venue"], "okx")
        self.assertGreater(ranked[0]["dominance_score"], ranked[1]["dominance_score"])
        self.assertLess(ranked[0]["queue_position"], ranked[1]["queue_position"])

    def test_split_plan_distributes_notional_across_top_venues(self) -> None:
        candidates = _annotate_multi_venue_dominance(
            [
                self._candidate("okx", available_depth_usd=22000.0, fill_probability=0.82, queue_priority_risk=0.14, latency_ms=28.0),
                self._candidate("binance", available_depth_usd=19000.0, fill_probability=0.78, queue_priority_risk=0.18, latency_ms=34.0),
                self._candidate("bingx", available_depth_usd=8000.0, fill_probability=0.58, queue_priority_risk=0.34, latency_ms=60.0),
            ]
        )

        split_plan = _build_multi_venue_split_plan(candidates, "buy", 12000.0)

        self.assertEqual(split_plan["mode"], "multiVenueSplit")
        self.assertGreaterEqual(split_plan["venue_count"], 2)
        self.assertGreater(split_plan["coverage_ratio"], 0.95)
        self.assertEqual(split_plan["primary_venue"], "okx")
        self.assertAlmostEqual(
            sum(float(slice_item["share_pct"]) for slice_item in split_plan["slices"]),
            split_plan["coverage_ratio"],
            places=4,
        )

    def test_route_context_detects_cross_exchange_arbitrage_with_execution_plan(self) -> None:
        candidates = _annotate_multi_venue_dominance(
            [
                self._candidate(
                    "binance",
                    best_bid=99.96,
                    best_ask=100.0,
                    spread_bps=0.8,
                    latency_ms=32.0,
                    queue_priority_risk=0.16,
                    fill_probability=0.81,
                    available_depth_usd=24000.0,
                ),
                self._candidate(
                    "okx",
                    best_bid=100.42,
                    best_ask=100.48,
                    spread_bps=0.9,
                    latency_ms=24.0,
                    queue_priority_risk=0.14,
                    fill_probability=0.79,
                    available_depth_usd=21000.0,
                ),
                self._candidate(
                    "bingx",
                    best_bid=100.08,
                    best_ask=100.14,
                    spread_bps=1.3,
                    latency_ms=58.0,
                    queue_priority_risk=0.36,
                    fill_probability=0.6,
                    available_depth_usd=9000.0,
                ),
            ]
        )

        context = _build_route_context(candidates, requested_notional_usd=5000.0)
        arbitrage = context["arbitrage"]

        self.assertTrue(arbitrage["opportunity"])
        self.assertEqual(arbitrage["buy"], "binance")
        self.assertEqual(arbitrage["sell"], "okx")
        self.assertGreater(arbitrage["net_spread_bps"], 0.0)
        self.assertIsInstance(arbitrage["execution_plan"], dict)
        self.assertGreater(arbitrage["execution_plan"]["totalNotionalUsd"], 0.0)

    def test_hedge_recommendation_enables_delta_guard_when_route_is_concentrated(self) -> None:
        split_plan = {
            "mode": "singleVenue",
            "slices": [
                {"venue": "okx", "share_pct": 0.82, "notional_usd": 4100.0},
                {"venue": "binance", "share_pct": 0.18, "notional_usd": 900.0},
            ],
        }

        recommendation = _build_hedge_recommendation(
            "buy",
            5000.0,
            {"venue": "okx"},
            {"venue": "binance"},
            split_plan,
            {"opportunity": False},
        )

        self.assertTrue(recommendation["enabled"])
        self.assertEqual(recommendation["mode"], "inventoryDeltaGuard")
        self.assertEqual(recommendation["venue"], "binance")
        self.assertEqual(recommendation["side"], "sell")
        self.assertGreater(recommendation["hedge_notional_usd"], 0.0)


if __name__ == "__main__":
    unittest.main()