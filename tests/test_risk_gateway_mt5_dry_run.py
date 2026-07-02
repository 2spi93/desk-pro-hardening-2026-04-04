from __future__ import annotations

import asyncio
import importlib
from unittest.mock import patch
import unittest


class RiskGatewayMt5DryRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.risk_gateway = importlib.import_module("apps.risk_gateway.main")
        self.risk_gateway.STATE["daily_notional_used_usd"] = 0.0
        self.risk_gateway.STATE["daily_budget_date"] = self.risk_gateway._today_utc()
        self.risk_gateway.STATE["exposure_by_instrument"] = {}

    def _policy(self) -> dict:
        return {
            "policy_version": "test",
            "allowed_system_modes": ["managed_live", "suggest"],
            "max_trade_notional_usd": 100.0,
            "daily_notional_limit_usd": 1000.0,
            "max_slippage_bps": 50,
            "blocked_instruments": [],
            "conditional_instrument_rules": {},
            "paper_only": False,
        }

    def _request(self, *, dry_run: bool) -> object:
        return self.risk_gateway.Mt5OrderRiskRequest(
            account_id="541283177",
            symbol="BTCUSD",
            side="buy",
            lots=0.01,
            estimated_notional_usd=5.0,
            max_spread_bps=25,
            system_mode="managed_live",
            dry_run=dry_run,
        )

    def test_mt5_order_dry_run_does_not_consume_budget_or_exposure(self) -> None:
        with patch.object(self.risk_gateway, "load_policy", return_value=self._policy()):
            result = asyncio.run(self.risk_gateway.mt5_order_check(self._request(dry_run=True)))

        self.assertEqual(result["decision"], "accept")
        self.assertIn("within_policy_dry_run", result["reasons"])
        self.assertEqual(self.risk_gateway.STATE["daily_notional_used_usd"], 0.0)
        self.assertEqual(self.risk_gateway.STATE["exposure_by_instrument"], {})
        self.assertTrue(result["risk_snapshot"]["dry_run"])

    def test_mt5_order_live_check_consumes_budget_and_exposure(self) -> None:
        with patch.object(self.risk_gateway, "load_policy", return_value=self._policy()):
            result = asyncio.run(self.risk_gateway.mt5_order_check(self._request(dry_run=False)))

        self.assertEqual(result["decision"], "accept")
        self.assertIn("within_policy", result["reasons"])
        self.assertEqual(self.risk_gateway.STATE["daily_notional_used_usd"], 5.0)
        self.assertEqual(self.risk_gateway.STATE["exposure_by_instrument"], {"BTCUSD": 5.0})
        self.assertFalse(result["risk_snapshot"]["dry_run"])

    def test_mt5_order_release_restores_budget_and_exposure(self) -> None:
        with patch.object(self.risk_gateway, "load_policy", return_value=self._policy()):
            asyncio.run(self.risk_gateway.mt5_order_check(self._request(dry_run=False)))
            result = asyncio.run(
                self.risk_gateway.mt5_order_release(
                    self.risk_gateway.Mt5OrderRiskReleaseRequest(
                        symbol="BTCUSD",
                        side="buy",
                        estimated_notional_usd=5.0,
                    )
                )
            )

        self.assertEqual(result["status"], "released")
        self.assertEqual(self.risk_gateway.STATE["daily_notional_used_usd"], 0.0)
        self.assertEqual(self.risk_gateway.STATE["exposure_by_instrument"], {})

    def test_pre_trade_release_restores_budget_and_exposure(self) -> None:
        with patch.object(self.risk_gateway, "load_policy", return_value=self._policy()):
            asyncio.run(self.risk_gateway.mt5_order_check(self._request(dry_run=False)))
            result = asyncio.run(
                self.risk_gateway.pre_trade_release(
                    self.risk_gateway.RiskReleaseRequest(
                        symbol="BTCUSD",
                        side="buy",
                        estimated_notional_usd=5.0,
                    )
                )
            )

        self.assertEqual(result["status"], "released")
        self.assertEqual(self.risk_gateway.STATE["daily_notional_used_usd"], 0.0)
        self.assertEqual(self.risk_gateway.STATE["exposure_by_instrument"], {})

    def test_daily_budget_rolls_over_on_new_utc_day(self) -> None:
        self.risk_gateway.STATE["daily_notional_used_usd"] = 30.0
        self.risk_gateway.STATE["daily_budget_date"] = "2026-07-01"
        with patch.object(self.risk_gateway, "_today_utc", return_value="2026-07-02"), \
             patch.object(self.risk_gateway, "load_policy", return_value=self._policy()):
            result = asyncio.run(self.risk_gateway.mt5_order_check(self._request(dry_run=False)))

        self.assertEqual(result["decision"], "accept")
        self.assertEqual(self.risk_gateway.STATE["daily_budget_date"], "2026-07-02")
        self.assertEqual(self.risk_gateway.STATE["daily_notional_used_usd"], 5.0)


if __name__ == "__main__":
    unittest.main()
