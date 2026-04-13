from __future__ import annotations

import unittest
from unittest.mock import patch

from apps.control_plane import main as control_plane


class ControlPlaneLiveCapabilityTests(unittest.TestCase):
    maxDiff = None

    def _base_policy(self) -> dict:
        provider_policy = {
            "enabled": True,
            "require_route_flag": True,
            "allowed_system_modes": [],
            "allow_smoke_test_in_modes": [],
            "max_order_notional_usd": 0.0,
            "default_order_notional_usd": 0.0,
            "smoke_test_notional_usd": 0.0,
            "smoke_limit_offset_bps": 0.0,
            "primary_live_instrument": "",
            "conditional_live_rules": {},
        }
        return {
            "enabled": True,
            "providers": {
                "okx": dict(provider_policy),
                "mystery": dict(provider_policy),
            },
        }

    def _healthy_connector_snapshot(self, provider: str) -> dict:
        return {
            "provider": provider,
            "state": "nominal",
            "auto_disable_live": False,
            "diagnostic": "nominal",
            "diagnostics": ["nominal"],
            "health_score": 0.96,
            "health_action": "ok",
            "size_multiplier": 1.0,
        }

    def _linked_account(self) -> dict:
        return {
            "provider": "stub",
            "account_id": "acct-1",
            "mode": "trade",
            "credential_id": "cred-1",
        }

    def _credential(self) -> dict:
        return {
            "secret_payload": {
                "api_key": "key",
                "api_secret": "secret",
            },
        }

    def _resolve(self, provider: str) -> dict:
        with patch.object(control_plane, "_load_live_execution_policy", return_value=self._base_policy()), \
             patch.object(control_plane, "_provider_live_env_enabled", return_value=True), \
             patch.object(control_plane, "_connector_live_degradation_snapshot", side_effect=self._healthy_connector_snapshot), \
             patch.object(control_plane, "_linked_connector_account", return_value=self._linked_account()), \
             patch.object(control_plane, "_load_decrypted_connector_credential", return_value=self._credential()):
            return control_plane._resolve_live_execution_request(
                provider,
                "acct-1",
                requested_notional_usd=100.0,
                explicit_flag=True,
                purpose="execute",
                symbol="BTCUSDT",
                regime="TREND",
                confidence=0.9,
            )

    def test_exchange_capability_catalog_exposes_ui_contract(self) -> None:
        payload = control_plane._exchange_capability_catalog()

        self.assertEqual(payload.get("status"), "ok")
        self.assertEqual(payload.get("capability_source"), "exchange-capabilities")
        self.assertEqual(payload.get("version"), "2026-04-10")

        by_provider = payload.get("by_provider")
        self.assertIsInstance(by_provider, dict)
        okx = by_provider.get("okx")
        bingx = by_provider.get("bingx")

        self.assertIsInstance(okx, dict)
        self.assertTrue(okx.get("known"))
        self.assertFalse(okx.get("execution"))
        self.assertTrue(okx.get("api_key_requires_passphrase"))
        self.assertEqual(okx.get("preferred_venue"), "paper-okx")

        self.assertIsInstance(bingx, dict)
        self.assertTrue(bingx.get("execution"))
        self.assertEqual(bingx.get("execution_venue"), "bingx")
        self.assertFalse(bingx.get("api_key_requires_passphrase"))

    def test_unknown_provider_is_fail_closed(self) -> None:
        result = self._resolve("mystery")

        self.assertFalse(result.get("enabled"))
        self.assertEqual(result.get("reasons"), ["unknown_provider"])
        self.assertEqual(result.get("execution_venue"), "")

        capabilities = result.get("capabilities")
        self.assertIsInstance(capabilities, dict)
        self.assertFalse(capabilities.get("known"))
        self.assertFalse(capabilities.get("execution"))

    def test_non_executable_provider_is_fail_closed(self) -> None:
        result = self._resolve("okx")

        self.assertFalse(result.get("enabled"))
        self.assertEqual(result.get("reasons"), ["execution_not_supported"])
        self.assertEqual(result.get("execution_venue"), "paper-okx")

        capabilities = result.get("capabilities")
        self.assertIsInstance(capabilities, dict)
        self.assertTrue(capabilities.get("known"))
        self.assertFalse(capabilities.get("execution"))
        self.assertTrue(capabilities.get("api_key_requires_passphrase"))


if __name__ == "__main__":
    unittest.main()