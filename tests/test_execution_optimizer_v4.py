from __future__ import annotations

import unittest

from apps.execution_router.optimizer_v4 import (
    adaptive_slippage_guard,
    calibrate_execution_desk_profile,
    compute_live_fill_score,
    decide_order_lifecycle,
    detect_liquidity_trap,
    detect_spoof_signal,
    initialize_queue_tracker,
    update_queue_tracker,
)


class ExecutionOptimizerV4Tests(unittest.TestCase):
    def _candidate(self, **overrides: object) -> dict[str, object]:
        candidate: dict[str, object] = {
            "venue": "bingx",
            "spread_bps": 3.2,
            "available_depth_usd": 18000.0,
            "latency_ms": 54.0,
            "fill_probability": 0.76,
            "freshness_ms": 900.0,
            "queue_priority_bias": 0.74,
            "incoming_flow_usd_per_min": 7200.0,
            "depth_imbalance": 0.12,
            "volume_imbalance": 0.18,
            "best_bid": 100.0,
            "best_ask": 100.2,
            "mark_price": 100.1,
            "depth_payload": {
                "bids": [[100.0, 55.0], [99.99, 30.0], [99.98, 24.0]],
                "asks": [[100.2, 48.0], [100.21, 26.0], [100.22, 20.0]],
            },
        }
        candidate.update(overrides)
        return candidate

    def test_profile_calibration_tightens_for_poor_fill_quality(self) -> None:
        strong = calibrate_execution_desk_profile(
            "bybit",
            {"fill_count": 180, "avg_slippage_bps": 1.2, "avg_fill_latency_ms": 75.0, "avg_fill_quality_score": 92.0, "replace_rate": 0.05, "amend_rate": 0.45, "cancel_rate": 0.02},
        )
        weak = calibrate_execution_desk_profile(
            "bitget",
            {"fill_count": 180, "avg_slippage_bps": 8.4, "avg_fill_latency_ms": 290.0, "avg_fill_quality_score": 58.0, "replace_rate": 0.62, "amend_rate": 0.04, "cancel_rate": 0.28},
        )

        self.assertGreater(weak["min_fill_probability"], strong["min_fill_probability"])
        self.assertLess(weak["max_spread_bps"], strong["max_spread_bps"])
        self.assertLess(weak["max_latency_ms"], strong["max_latency_ms"])
        self.assertGreater(weak["replace_below_fill_probability"], strong["replace_below_fill_probability"])
        self.assertGreater(weak["replace_rate"], strong["replace_rate"])

    def test_queue_tracker_advances_when_top_of_book_thins(self) -> None:
        profile = calibrate_execution_desk_profile("bingx", {"fill_count": 40})
        initial = self._candidate()
        tracker = initialize_queue_tracker(initial, {"queue_ahead_usd": 4200.0})
        current = self._candidate(
            incoming_flow_usd_per_min=9400.0,
            depth_payload={
                "bids": [[100.0, 22.0], [99.99, 18.0], [99.98, 12.0]],
                "asks": [[100.2, 48.0], [100.21, 26.0], [100.22, 20.0]],
            },
        )

        updated = update_queue_tracker(tracker, initial, current, "buy", 950.0)
        fill_live = compute_live_fill_score(updated, current, profile)

        self.assertLess(updated["queue_position_usd"], tracker["queue_position_usd"])
        self.assertGreater(fill_live["fill_score"], 0.2)

    def test_spoof_signal_blocks_lifecycle(self) -> None:
        profile = calibrate_execution_desk_profile("bingx", {"fill_count": 60, "avg_slippage_bps": 4.0, "avg_fill_latency_ms": 120.0, "avg_fill_quality_score": 74.0})
        previous = self._candidate(
            available_depth_usd=20000.0,
            depth_payload={
                "bids": [[100.0, 260.0], [99.99, 12.0], [99.98, 8.0]],
                "asks": [[100.2, 48.0], [100.21, 26.0], [100.22, 20.0]],
            },
        )
        current = self._candidate(
            available_depth_usd=22000.0,
            depth_payload={
                "bids": [[100.0, 16.0], [99.99, 14.0], [99.98, 10.0]],
                "asks": [[100.2, 48.0], [100.21, 26.0], [100.22, 20.0]],
            },
        )
        tracker = initialize_queue_tracker(previous, {"queue_ahead_usd": 3800.0})
        tracker = update_queue_tracker(tracker, previous, current, "buy", 600.0)
        fill_live = compute_live_fill_score(tracker, current, profile)
        spoof = detect_spoof_signal(previous, current, "buy", profile, 600.0)
        guard = adaptive_slippage_guard(current, profile, fill_live["fill_score"], spoof)
        lifecycle = decide_order_lifecycle(
            current,
            tracker,
            fill_live,
            spoof,
            guard,
            {"side": "buy", "status": "open", "order_type": "LIMIT", "price": 100.0},
            profile,
        )

        self.assertTrue(spoof["spoof_detected"])
        self.assertFalse(guard["allowed"])
        self.assertEqual(lifecycle["action"], "cancel")

    def test_high_fill_score_upgrades_limit_order_to_market(self) -> None:
        profile = calibrate_execution_desk_profile("bybit", {"fill_count": 140, "avg_slippage_bps": 1.0, "avg_fill_latency_ms": 48.0, "avg_fill_quality_score": 91.0})
        tracker = {"queue_position_usd": 40.0, "total_queue_usd": 1600.0}
        candidate = self._candidate(venue="bybit", latency_ms=28.0, spread_bps=1.1, incoming_flow_usd_per_min=20000.0, depth_imbalance=0.03, volume_imbalance=0.05)
        fill_live = compute_live_fill_score(tracker, candidate, profile)
        guard = adaptive_slippage_guard(candidate, profile, max(fill_live["fill_score"], 0.9), {"spoof_detected": False})
        lifecycle = decide_order_lifecycle(
            candidate,
            tracker,
            {**fill_live, "fill_score": max(fill_live["fill_score"], 0.91)},
            {"spoof_detected": False},
            guard,
            {"side": "buy", "status": "open", "order_type": "LIMIT", "price": 100.0},
            profile,
        )

        self.assertTrue(guard["allowed"])
        self.assertEqual(lifecycle["action"], "upgrade_to_market")

    def test_bingx_profile_uses_relaxed_native_thresholds(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})

        self.assertLess(profile["min_fill_probability"], 0.4)
        self.assertEqual(profile["max_latency_ms"], 150.0)
        self.assertEqual(profile["latency_soft_ms"], 100.0)
        self.assertEqual(profile["max_freshness_ms"], 300.0)
        self.assertFalse(profile["cancel_on_fill_score_guard"])
        self.assertTrue(profile["replace_on_fill_score_guard"])
        self.assertTrue(profile["replace_on_soft_guard"])

    def test_bingx_soft_fill_guard_prefers_replace_over_cancel(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})
        tracker = {"queue_position_usd": 1800.0, "total_queue_usd": 2200.0}
        candidate = self._candidate(
            venue="bingx-public",
            latency_ms=166.0,
            freshness_ms=340.0,
            spread_bps=2.2,
            incoming_flow_usd_per_min=1400.0,
            depth_imbalance=0.08,
            volume_imbalance=0.06,
        )
        fill_live = compute_live_fill_score(tracker, candidate, profile)
        guard = adaptive_slippage_guard(candidate, profile, fill_live["fill_score"], {"spoof_detected": False})
        lifecycle = decide_order_lifecycle(
            candidate,
            tracker,
            fill_live,
            {"spoof_detected": False},
            guard,
            {"side": "buy", "status": "open", "order_type": "LIMIT", "price": 100.0},
            profile,
        )

        self.assertIn("latency_above_profile", guard["reasons"])
        self.assertIn("freshness_above_profile", guard["reasons"])
        self.assertEqual(lifecycle["action"], "replace")
        self.assertEqual(lifecycle["reason"], "soft_guard_reprice")

    def test_bingx_entry_boost_lifts_fill_score_when_spread_is_clean(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})
        tracker = {"queue_position_usd": 500.0, "total_queue_usd": 2200.0}
        clean_candidate = self._candidate(venue="bingx-public", spread_bps=1.5, freshness_ms=80.0, latency_ms=70.0, incoming_flow_usd_per_min=3200.0)
        wide_candidate = self._candidate(venue="bingx-public", spread_bps=4.5, freshness_ms=80.0, latency_ms=70.0, incoming_flow_usd_per_min=3200.0)

        clean = compute_live_fill_score(tracker, clean_candidate, profile)
        wide = compute_live_fill_score(tracker, wide_candidate, profile)

        self.assertGreater(clean["entry_boost"], 0.0)
        self.assertEqual(wide["entry_boost"], 0.0)
        self.assertGreater(clean["fill_score"], wide["fill_score"])

    def test_queue_staleness_raises_aggressiveness_and_time_decay_metrics(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})
        tracker = {
            "queue_position_usd": 1400.0,
            "total_queue_usd": 1800.0,
            "trade_intensity": 0.18,
            "cancel_rate_estimate": 0.11,
            "liquidity_decay_rate": 0.14,
            "queue_velocity_usd_per_sec": 520.0,
            "queue_rank_estimate": 0.78,
            "time_in_queue_ms": 2600.0,
        }
        candidate = self._candidate(venue="bingx-public", spread_bps=1.6, depth_imbalance=0.82, incoming_flow_usd_per_min=4800.0)

        live_fill = compute_live_fill_score(tracker, candidate, profile)

        self.assertGreaterEqual(live_fill["aggressiveness"], 0.6)
        self.assertTrue(live_fill["should_move_ahead"])
        self.assertGreater(live_fill["dominance_score"], 0.0)
        self.assertIsNotNone(live_fill["time_to_fill_estimate_ms"])

    def test_liquidity_trap_detected_blocks_with_specific_reason(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})
        tracker = {
            "queue_position_usd": 900.0,
            "total_queue_usd": 1600.0,
            "trade_intensity": 0.02,
            "cancel_rate_estimate": 0.01,
            "liquidity_decay_rate": 0.01,
            "queue_velocity_usd_per_sec": 25.0,
            "queue_rank_estimate": 0.56,
            "time_in_queue_ms": 2200.0,
        }
        candidate = self._candidate(
            venue="bingx-public",
            available_depth_usd=5200.0,
            spread_bps=1.7,
            depth_imbalance=0.9,
            incoming_flow_usd_per_min=120.0,
        )

        live_fill = compute_live_fill_score(tracker, candidate, profile)
        liquidity_signal = detect_liquidity_trap(candidate, live_fill, profile)
        guard = adaptive_slippage_guard(candidate, profile, live_fill["fill_score"], {"spoof_detected": False}, liquidity_signal)

        self.assertTrue(liquidity_signal["liquidity_trap_detected"])
        self.assertIn("liquidity_trap_detected", guard["reasons"])

    def test_queue_reprice_mid_when_tail_risk_persists(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})
        tracker = {
            "queue_position_usd": 1500.0,
            "total_queue_usd": 2000.0,
            "trade_intensity": 0.22,
            "cancel_rate_estimate": 0.08,
            "liquidity_decay_rate": 0.16,
            "queue_velocity_usd_per_sec": 340.0,
            "queue_rank_estimate": 0.75,
            "time_in_queue_ms": 2400.0,
        }
        candidate = self._candidate(
            venue="bingx-public",
            spread_bps=1.8,
            latency_ms=70.0,
            freshness_ms=120.0,
            best_bid=100.0,
            best_ask=100.2,
            depth_imbalance=0.81,
            incoming_flow_usd_per_min=5200.0,
        )

        live_fill = compute_live_fill_score(tracker, candidate, profile)
        guard = adaptive_slippage_guard(candidate, profile, live_fill["fill_score"], {"spoof_detected": False})
        lifecycle = decide_order_lifecycle(
            candidate,
            tracker,
            live_fill,
            {"spoof_detected": False},
            guard,
            {"side": "buy", "status": "open", "order_type": "LIMIT", "price": 100.0},
            profile,
        )

        self.assertEqual(lifecycle["action"], "replace")
        self.assertEqual(lifecycle["reason"], "queue_reprice_mid")
        self.assertGreater(lifecycle["target_price"], 100.0)

    def test_bingx_depth_imbalance_prefers_replace_with_size_reduction(self) -> None:
        profile = calibrate_execution_desk_profile("bingx-public", {"fill_count": 0})
        tracker = {"queue_position_usd": 900.0, "total_queue_usd": 2200.0}
        candidate = self._candidate(
            venue="bingx-public",
            latency_ms=55.0,
            freshness_ms=110.0,
            spread_bps=1.9,
            depth_imbalance=0.93,
            volume_imbalance=0.02,
            incoming_flow_usd_per_min=3800.0,
        )
        fill_live = compute_live_fill_score(tracker, candidate, profile)
        guard = adaptive_slippage_guard(candidate, profile, fill_live["fill_score"], {"spoof_detected": False})
        lifecycle = decide_order_lifecycle(
            candidate,
            tracker,
            fill_live,
            {"spoof_detected": False},
            guard,
            {"side": "buy", "status": "open", "order_type": "LIMIT", "price": 100.0},
            profile,
        )

        self.assertIn("depth_imbalance_above_profile", guard["reasons"])
        self.assertEqual(lifecycle["action"], "replace")
        self.assertEqual(lifecycle["reason"], "depth_imbalance_reprice")
        self.assertEqual(lifecycle["target_notional_scale"], 0.7)


if __name__ == "__main__":
    unittest.main()