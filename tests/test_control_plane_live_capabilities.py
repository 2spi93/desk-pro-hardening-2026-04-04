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

    def test_kill_switch_reset_clears_stale_guardian_provenance(self) -> None:
        state = {
            "active": True,
            "reason": "api_errors_threshold",
            "activated_at": "2026-06-18T20:38:24Z",
            "stats": {"api_errors": 5},
            "constitutional_guardian": {"owner": "constitutional_runtime_guardian"},
            "freeze_event_id": 40,
            "freeze_timeline": [{"phase": "freeze_activated"}],
            "incident_ticket_key": "INC-old",
            "decision_ids": ["old"],
        }

        reset = control_plane._reset_kill_switch_state_payload(state, by="admin")

        self.assertFalse(reset["active"])
        self.assertEqual(reset["reason"], "manual_reset")
        self.assertEqual(reset["stats"]["api_errors"], 0)
        self.assertNotIn("constitutional_guardian", reset)
        self.assertNotIn("freeze_event_id", reset)
        self.assertNotIn("incident_ticket_key", reset)

    def test_kill_switch_activation_sets_current_provenance(self) -> None:
        state = {
            "active": False,
            "reason": "manual_reset",
            "constitutional_guardian": {"owner": "stale"},
            "incident_ticket_key": "INC-old",
        }

        activated = control_plane._activated_kill_switch_state_payload(
            state,
            "execution-router",
            "api_errors_threshold",
            {"detail": "intent_execution_failed", "count": 5},
        )

        self.assertTrue(activated["active"])
        self.assertEqual(activated["reason"], "api_errors_threshold")
        self.assertEqual(activated["activation"]["source"], "execution-router")
        self.assertEqual(activated["activation"]["reason"], "api_errors_threshold")
        self.assertNotIn("constitutional_guardian", activated)
        self.assertNotIn("incident_ticket_key", activated)

    def test_opportunity_gate_stale_trigger_after_reset_is_ignored(self) -> None:
        state = {
            "active": False,
            "reason": "manual_reset",
            "last_reset": {"by": "admin", "at": "2026-06-30T07:10:06Z", "event_id": "reset-1"},
        }
        payload = {
            "gate": {
                "evaluated_at": "2026-06-30T07:09:59Z",
                "updated_at": "2026-06-30T07:09:59Z",
                "source": "execution-router/health",
                "metrics": {"consistency": 10.0, "bus_seq": 44},
                "thresholds": {"kill_consistency_pct": 65.0},
            }
        }

        precedence = control_plane._kill_switch_activation_precedence(
            state,
            "opportunity_gate",
            "consistency_kill_threshold",
            payload,
        )

        self.assertFalse(precedence["allowed"])
        self.assertEqual(precedence["classification"], "STALE_TRIGGER_IGNORED")
        self.assertEqual(precedence["reset_event_id"], "reset-1")
        self.assertEqual(precedence["source_event_id"], "44")

    def test_opportunity_gate_healthy_metric_after_reset_is_ignored(self) -> None:
        state = {
            "active": False,
            "reason": "manual_reset",
            "last_reset": {"by": "admin", "at": "2026-06-30T07:10:06Z", "event_id": "reset-1"},
        }
        payload = {
            "gate": {
                "evaluated_at": "2026-06-30T07:10:30Z",
                "metrics": {"consistency": 100.0, "bus_seq": 45},
                "thresholds": {"kill_consistency_pct": 65.0},
            }
        }

        precedence = control_plane._kill_switch_activation_precedence(
            state,
            "opportunity_gate",
            "consistency_kill_threshold",
            payload,
        )

        self.assertFalse(precedence["allowed"])
        self.assertEqual(precedence["classification"], "HEALTHY_TRIGGER_IGNORED")
        self.assertEqual(precedence["metric_observed"], 100.0)
        self.assertEqual(precedence["threshold"], 65.0)

    def test_opportunity_gate_new_bad_metric_after_reset_can_rearm(self) -> None:
        state = {
            "active": False,
            "reason": "manual_reset",
            "last_reset": {"by": "admin", "at": "2026-06-30T07:10:06Z", "event_id": "reset-1"},
        }
        payload = {
            "gate": {
                "evaluated_at": "2026-06-30T07:10:30Z",
                "metrics": {"consistency": 42.0, "bus_seq": 46},
                "thresholds": {"kill_consistency_pct": 65.0},
            }
        }

        precedence = control_plane._kill_switch_activation_precedence(
            state,
            "opportunity_gate",
            "consistency_kill_threshold",
            payload,
        )

        self.assertTrue(precedence["allowed"])
        self.assertEqual(precedence["classification"], "NEW_TRIGGER_ACCEPTED")
        self.assertEqual(precedence["source_event_id"], "46")

    def test_local_execution_lock_ignores_stale_guardian_and_uses_latest_event(self) -> None:
        state = {
            "active": True,
            "reason": "api_errors_threshold",
            "activated_at": "2026-06-18T20:38:24Z",
            "stats": {"api_errors": 5},
            "constitutional_guardian": {
                "owner": "constitutional_runtime_guardian",
                "reason": "deviation_kill_threshold",
                "triggered_at": "2026-05-22T04:42:40Z",
                "incident_ticket_key": "INC-old",
                "freeze_event_id": 40,
            },
            "incident_ticket_key": "INC-old",
            "freeze_event_id": 40,
        }

        with patch.object(control_plane, "_kill_switch_state", return_value=state), \
             patch.object(control_plane, "_latest_kill_switch_activation_event", return_value={
                 "source": "execution-router",
                 "reason": "api_errors_threshold",
                 "payload": {"detail": "intent_execution_failed", "count": 5},
                 "created_at": "2026-06-18T20:38:24Z",
             }):
            lock = control_plane._local_execution_lock_snapshot(execution_phase="test")

        self.assertTrue(lock["lock_active"])
        self.assertEqual(lock["lock_owner"], "execution-router")
        self.assertEqual(lock["lock_reason"], "api_errors_threshold")
        self.assertTrue(lock["stale_guardian_ignored"])
        self.assertIsNone(lock["incident_ticket_key"])
        self.assertIsNone(lock["freeze_event_id"])

    def test_unknown_provider_is_fail_closed(self) -> None:
        result = self._resolve("mystery")

        self.assertFalse(result.get("enabled"))
        self.assertIn("unknown_provider", result.get("reasons") or [])
        self.assertEqual(result.get("execution_venue"), "")

        capabilities = result.get("capabilities")
        self.assertIsInstance(capabilities, dict)
        self.assertFalse(capabilities.get("known"))
        self.assertFalse(capabilities.get("execution"))

    def test_non_executable_provider_is_fail_closed(self) -> None:
        result = self._resolve("okx")

        self.assertFalse(result.get("enabled"))
        self.assertIn("execution_not_supported", result.get("reasons") or [])
        self.assertEqual(result.get("execution_venue"), "paper-okx")

        capabilities = result.get("capabilities")
        self.assertIsInstance(capabilities, dict)
        self.assertTrue(capabilities.get("known"))
        self.assertFalse(capabilities.get("execution"))
        self.assertTrue(capabilities.get("api_key_requires_passphrase"))

    def test_public_live_execution_resolution_redacts_secret_payload(self) -> None:
        result = control_plane._public_live_execution_resolution(
            {
                "enabled": True,
                "provider": "bingx",
                "secret_payload": {"api_key": "key", "api_secret": "secret"},
            }
        )

        self.assertNotIn("secret_payload", result)
        self.assertEqual(result.get("credentials"), "available")

    def test_apply_live_execution_auto_sizing_promotes_intent_target_notional(self) -> None:
        intent_payload = {
            "intent_id": "intent-1",
            "strategy_id": "strat-1",
            "portfolio_id": "pf-1",
            "venue": "bingx",
            "instrument": "BTCUSDT",
            "side": "buy",
            "reason_code": "signal",
            "confidence": 0.8,
            "target_notional_usd": 2.5,
            "max_slippage_bps": 10,
            "explainability": {
                "live_execution": {
                    "enabled": True,
                    "provider": "bingx",
                    "account_id": "acct-1",
                }
            },
        }
        constraints = {
            "status": "ready_preflight",
            "requested_notional_usd": 2.5,
            "effective_notional_usd": 7.5,
            "supports_requested_notional": False,
            "supports_auto_adjusted_notional": True,
            "auto_adjustment": {
                "enabled": True,
                "applied": True,
                "requested_notional_usd": 2.5,
                "adjusted_notional_usd": 7.5,
                "min_notional_usd": 7.5,
                "reason": "venue_min_notional",
            },
        }

        adjusted = control_plane._apply_live_execution_auto_sizing(intent_payload, constraints)

        self.assertEqual(adjusted["target_notional_usd"], 7.5)
        live_execution = adjusted["explainability"]["live_execution"]
        self.assertTrue(live_execution["auto_size"])
        self.assertEqual(live_execution["requested_notional_usd"], 2.5)
        self.assertEqual(live_execution["effective_notional_usd"], 7.5)

    def test_live_execution_preflight_rejected_accepts_auto_adjusted_notional(self) -> None:
        constraints = {
            "status": "ready_preflight",
            "requested_notional_usd": 2.5,
            "effective_notional_usd": 7.5,
            "supports_requested_notional": False,
            "supports_auto_adjusted_notional": True,
        }

        self.assertFalse(control_plane._live_execution_preflight_rejected(constraints))

    def test_apply_live_execution_dynamic_protection_builds_tp_sl_from_effective_notional(self) -> None:
        intent_payload = {
            "intent_id": "intent-1",
            "strategy_id": "strat-1",
            "portfolio_id": "pf-1",
            "venue": "bingx",
            "instrument": "BTCUSDT",
            "side": "buy",
            "reason_code": "signal",
            "confidence": 0.84,
            "target_notional_usd": 7.5,
            "max_slippage_bps": 10,
            "explainability": {
                "regime": "TREND",
                "live_execution": {
                    "enabled": True,
                    "provider": "bingx",
                    "account_id": "acct-1",
                    "auto_size": True,
                    "auto_protection": True,
                    "effective_notional_usd": 7.5,
                }
            },
        }
        constraints = {
            "status": "ready_preflight",
            "reference_price": 70000.0,
            "effective_notional_usd": 7.5,
            "requested_notional_usd": 2.5,
            "price_precision": 1,
            "supports_auto_adjusted_notional": True,
        }

        adjusted = control_plane._apply_live_execution_dynamic_protection(intent_payload, constraints)

        protection = adjusted.get("protection")
        self.assertIsInstance(protection, dict)
        self.assertGreater(protection["take_profit"]["trigger_price"], 70000.0)
        self.assertLess(protection["stop_loss"]["trigger_price"], 70000.0)
        dynamic = adjusted["explainability"]["live_execution"]["dynamic_protection"]
        self.assertTrue(dynamic["applied"])
        self.assertEqual(dynamic["effective_notional_usd"], 7.5)

    def test_apply_live_execution_dynamic_protection_preserves_explicit_protection(self) -> None:
        intent_payload = {
            "intent_id": "intent-1",
            "strategy_id": "strat-1",
            "portfolio_id": "pf-1",
            "venue": "bingx",
            "instrument": "BTCUSDT",
            "side": "buy",
            "reason_code": "signal",
            "confidence": 0.84,
            "target_notional_usd": 7.5,
            "max_slippage_bps": 10,
            "protection": {
                "take_profit": {
                    "trigger_price": 70500.0,
                    "order_type": "market",
                    "working_type": "MARK_PRICE",
                },
                "stop_loss": {
                    "trigger_price": 69500.0,
                    "order_type": "market",
                    "working_type": "MARK_PRICE",
                },
            },
            "explainability": {
                "live_execution": {
                    "enabled": True,
                    "provider": "bingx",
                    "account_id": "acct-1",
                    "auto_protection": True,
                }
            },
        }
        constraints = {
            "status": "ready_preflight",
            "reference_price": 70000.0,
            "effective_notional_usd": 7.5,
            "price_precision": 1,
            "supports_auto_adjusted_notional": True,
        }

        adjusted = control_plane._apply_live_execution_dynamic_protection(intent_payload, constraints)

        self.assertEqual(adjusted["protection"], intent_payload["protection"])
        self.assertNotIn("dynamic_protection", adjusted["explainability"]["live_execution"])

    def test_intent_live_execution_context_exposes_dry_run_fields(self) -> None:
        context = control_plane._intent_live_execution_context(
            {
                "explainability": {
                    "live_execution": {
                        "enabled": True,
                        "provider": "bingx",
                        "account_id": "acct-1",
                        "dry_run": True,
                        "dry_run_accepted_legs": ["take_profit", "stop_loss"],
                    }
                }
            }
        )

        self.assertTrue(context["dry_run"])
        self.assertEqual(context["dry_run_accepted_legs"], ["take_profit", "stop_loss"])

    def test_resolve_live_execution_request_preserves_approved_auto_sized_notional(self) -> None:
        policy = {
            "enabled": True,
            "providers": {
                "bingx": {
                    "enabled": True,
                    "require_route_flag": True,
                    "allowed_system_modes": [],
                    "allow_smoke_test_in_modes": [],
                    "max_order_notional_usd": 10.0,
                    "default_order_notional_usd": 7.5,
                    "smoke_test_notional_usd": 7.5,
                    "smoke_limit_offset_bps": 3500,
                    "primary_live_instrument": "BTCUSDT",
                }
            },
        }
        micro_live = {
            "enabled": True,
            "allowed_symbols": ["BTCUSDT"],
            "current_stage_config": {
                "allowed_system_modes": [],
                "allowed_symbols": ["BTCUSDT"],
                "size_multiplier": 1.0,
                "max_order_notional_usd": 7.5,
            },
        }
        capabilities = {
            "known": True,
            "execution": True,
            "preferred_venue": "bingx",
            "execution_venue": "bingx",
        }

        with patch.object(control_plane, "_load_live_execution_policy", return_value=policy), \
             patch.object(control_plane, "_provider_live_env_enabled", return_value=True), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value=micro_live), \
             patch.object(control_plane, "_exchange_capabilities", return_value=capabilities), \
             patch.object(control_plane, "_connector_live_degradation_snapshot", return_value=self._healthy_connector_snapshot("bingx")), \
             patch.object(control_plane, "_linked_connector_account", return_value=self._linked_account()), \
             patch.object(control_plane, "_load_decrypted_connector_credential", return_value=self._credential()):
            result = control_plane._resolve_live_execution_request(
                "bingx",
                "acct-1",
                requested_notional_usd=7.53855,
                explicit_flag=True,
                purpose="execute",
                symbol="BTCUSDT",
                regime="TREND",
                confidence=0.96,
                preserve_requested_notional=True,
            )

        self.assertTrue(result["enabled"])
        self.assertEqual(result["effective_notional_usd"], 7.53855)
        self.assertNotIn("requested_notional_exceeds_live_limit", result["reasons"])
        self.assertIn("micro_live_stage_cap_preserved", result["advisories"])

    def test_resolve_live_execution_request_caps_to_exploitable_capital(self) -> None:
        policy = {
            "enabled": True,
            "providers": {
                "bingx": {
                    "enabled": True,
                    "require_route_flag": True,
                    "allowed_system_modes": [],
                    "allow_smoke_test_in_modes": [],
                    "max_order_notional_usd": 10.0,
                    "max_notional_pct_of_exploitable_capital": 0.5,
                    "default_order_notional_usd": 7.5,
                    "smoke_test_notional_usd": 7.5,
                    "smoke_limit_offset_bps": 3500,
                    "primary_live_instrument": "BTCUSDT",
                }
            },
        }
        capabilities = {
            "known": True,
            "execution": True,
            "preferred_venue": "bingx",
            "execution_venue": "bingx",
        }

        with patch.object(control_plane, "_load_live_execution_policy", return_value=policy), \
             patch.object(control_plane, "_provider_live_env_enabled", return_value=True), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value={"enabled": False}), \
             patch.object(control_plane, "_exchange_capabilities", return_value=capabilities), \
             patch.object(control_plane, "_connector_live_degradation_snapshot", return_value=self._healthy_connector_snapshot("bingx")), \
             patch.object(control_plane, "_linked_connector_account", return_value=self._linked_account()), \
             patch.object(control_plane, "_load_decrypted_connector_credential", return_value=self._credential()), \
             patch.object(control_plane, "_account_exploitable_capital_snapshot", return_value={"account_id": "acct-1", "exploitable_capital_usd": 8.0, "margin_available_usd": 8.0}):
            result = control_plane._resolve_live_execution_request(
                "bingx",
                "acct-1",
                requested_notional_usd=7.0,
                explicit_flag=True,
                purpose="execute",
                symbol="BTCUSDT",
                regime="TREND",
                confidence=0.92,
            )

        self.assertTrue(result["enabled"])
        self.assertEqual(result["effective_notional_usd"], 4.0)
        self.assertIn("exploitable_capital_cap_applied", result["advisories"])

    def test_evaluate_go_live_hardening_blocks_no_trade_context(self) -> None:
        with patch.object(control_plane, "_account_live_exposure_snapshot", return_value={"exposure_known": True, "projected_total_exposure_pct": 5.0, "projected_symbol_exposure_pct": 5.0}), \
             patch.object(control_plane, "_go_live_signal_loop_snapshot", return_value={"lookback_minutes": 20, "repeat_count": 0, "same_source_repeat_count": 0, "blocked_repeat_count": 0}), \
             patch.object(control_plane, "_kill_switch_state", return_value={"active": False, "stats": {}}), \
             patch.object(control_plane, "_kill_switch_thresholds", return_value={"max_drawdown_intraday": 100.0}), \
             patch.object(control_plane, "_recent_pending_live_approval_count", return_value=0), \
             patch.object(control_plane, "_load_live_execution_policy", return_value=control_plane._default_live_execution_policy()), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value={"enabled": False, "current_stage": "", "current_stage_config": {}}), \
             patch.object(control_plane, "_drawdown_velocity_snapshot", return_value={"lookback_minutes": 90, "recent_loss_usd": 0.0, "recent_net_result_usd": 0.0, "sample_count": 0}), \
             patch.object(control_plane, "_oracle_stability_snapshot", return_value={"enabled": True, "score": 1.0, "state": "stable", "sample_count": 5, "transition_count": 0, "confidence_span": 0.01}), \
             patch.object(control_plane, "append_audit"):
            result = control_plane._evaluate_go_live_hardening(
                source="signal-webhook",
                provider="mt5",
                account_id="acct-1",
                symbol="EURUSD",
                side="buy",
                requested_notional_usd=7.0,
                confidence=0.91,
                live_requested=True,
                purpose="execute",
                no_trade_context={
                    "no_trade": True,
                    "no_trade_dominance": True,
                    "no_trade_state": "dominant_block",
                    "no_trade_reasons": ["dominance_environment_stack"],
                },
            )

        self.assertEqual(result["status"], "blocked")
        self.assertIn("execution_context_no_trade", result["reasons"])
        self.assertIn("execution_context_no_trade_dominance", result["reasons"])

    def test_evaluate_go_live_hardening_allows_configured_autonomous_source(self) -> None:
        policy = control_plane._default_live_execution_policy()
        policy["go_live_hardening"]["require_human_for_autonomous_sources"] = False

        with patch.object(control_plane, "_account_live_exposure_snapshot", return_value={"exposure_known": True, "equity_usd": 10000.0, "projected_total_exposure_pct": 5.0, "projected_symbol_exposure_pct": 5.0}), \
             patch.object(control_plane, "_go_live_signal_loop_snapshot", return_value={"lookback_minutes": 20, "repeat_count": 0, "same_source_repeat_count": 0, "blocked_repeat_count": 0}), \
             patch.object(control_plane, "_kill_switch_state", return_value={"active": False, "stats": {}}), \
             patch.object(control_plane, "_kill_switch_thresholds", return_value={"max_drawdown_intraday": 100.0}), \
             patch.object(control_plane, "_recent_pending_live_approval_count", return_value=0), \
             patch.object(control_plane, "_load_live_execution_policy", return_value=policy), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value={"enabled": False, "current_stage": "", "current_stage_config": {}}), \
             patch.object(control_plane, "_drawdown_velocity_snapshot", return_value={"lookback_minutes": 90, "recent_loss_usd": 0.0, "recent_net_result_usd": 0.0, "sample_count": 0}), \
             patch.object(control_plane, "append_audit") as append_audit:
            result = control_plane._evaluate_go_live_hardening(
                source="kairos-shadow-runtime",
                provider="bingx",
                account_id="acct-1",
                symbol="BTCUSDT",
                side="buy",
                requested_notional_usd=4.5,
                confidence=0.91,
                live_requested=True,
                purpose="execute",
                record_decision=False,
            )

        self.assertEqual(result["status"], "approved")
        self.assertNotIn("governance_approval_required_autonomous_source", result["reasons"])
        append_audit.assert_not_called()

    def test_resolve_live_execution_request_mt5_auto_sizes_by_stage_bucket(self) -> None:
        policy = {
            "enabled": True,
            "providers": {
                "mt5": {
                    "enabled": True,
                    "require_route_flag": True,
                    "allowed_system_modes": [],
                    "allow_smoke_test_in_modes": [],
                    "max_order_notional_usd": 35.0,
                    "max_notional_pct_of_exploitable_capital": 0.0035,
                    "default_order_notional_usd": 10.0,
                    "smoke_test_notional_usd": 5.0,
                    "smoke_limit_offset_bps": 0.0,
                    "primary_live_instrument": "EURUSD",
                }
            },
        }
        micro_live = {
            "enabled": True,
            "allowed_symbols": [],
            "current_stage": "micro_risk",
            "current_stage_config": {
                "allowed_system_modes": [],
                "allowed_symbols": [],
                "size_multiplier": 1.0,
                "max_order_notional_usd": 15.0,
                "max_notional_pct_of_exploitable_capital": 0.0015,
                "auto_sizing": {
                    "enabled": True,
                    "basis": "exploitable_capital",
                        "regime_confidence_decay": {
                            "enabled": True,
                            "floor": 0.72,
                        },
                    "buckets": [
                        {
                            "name": "standard",
                            "min_confidence": 0.0,
                            "notional_pct_of_exploitable_capital": 0.001,
                            "max_order_notional_usd": 15.0,
                        },
                        {
                            "name": "premium",
                            "min_confidence": 0.88,
                            "notional_pct_of_exploitable_capital": 0.0015,
                            "max_order_notional_usd": 15.0,
                        },
                    ],
                },
            },
        }
        capabilities = {
            "known": True,
            "execution": True,
            "preferred_venue": "mt5",
            "execution_venue": "mt5",
        }

        with patch.object(control_plane, "_load_live_execution_policy", return_value=policy), \
             patch.object(control_plane, "_provider_live_env_enabled", return_value=True), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value=micro_live), \
               patch.object(control_plane, "_regime_confidence_decay_snapshot", return_value={"enabled": True, "regime": "TREND", "score": 0.8, "state": "watch", "sample_count": 8, "drift_detected": False}), \
             patch.object(control_plane, "_exchange_capabilities", return_value=capabilities), \
             patch.object(control_plane, "_connector_live_degradation_snapshot", return_value=self._healthy_connector_snapshot("mt5")), \
             patch.object(control_plane, "_linked_connector_account", return_value=self._linked_account()), \
             patch.object(control_plane, "_load_decrypted_connector_credential", return_value=self._credential()), \
             patch.object(control_plane, "_account_exploitable_capital_snapshot", return_value={"account_id": "acct-1", "exploitable_capital_usd": 10000.0, "margin_available_usd": 10000.0}):
            result = control_plane._resolve_live_execution_request(
                "mt5",
                "acct-1",
                requested_notional_usd=40.0,
                explicit_flag=True,
                purpose="execute",
                symbol="EURUSD",
                regime="TREND",
                confidence=0.7,
            )

        self.assertTrue(result["enabled"])
        self.assertEqual(result["effective_notional_usd"], 8.0)
        self.assertTrue(result["auto_sizing"]["applied"])
        self.assertEqual(result["auto_sizing"]["selected_bucket"]["name"], "standard")
        self.assertEqual(result["auto_sizing"]["regime_confidence_decay"]["score"], 0.8)
        self.assertIn("regime_confidence_decay_applied", result["advisories"])
        self.assertIn("stage_auto_sizing_cap_applied", result["advisories"])

    def test_evaluate_go_live_hardening_blocks_unstable_oracle(self) -> None:
        with patch.object(control_plane, "_account_live_exposure_snapshot", return_value={"exposure_known": True, "projected_total_exposure_pct": 5.0, "projected_symbol_exposure_pct": 5.0}), \
             patch.object(control_plane, "_go_live_signal_loop_snapshot", return_value={"lookback_minutes": 20, "repeat_count": 0, "same_source_repeat_count": 0, "blocked_repeat_count": 0}), \
             patch.object(control_plane, "_kill_switch_state", return_value={"active": False, "stats": {}}), \
             patch.object(control_plane, "_kill_switch_thresholds", return_value={"max_drawdown_intraday": 100.0}), \
             patch.object(control_plane, "_recent_pending_live_approval_count", return_value=0), \
             patch.object(control_plane, "_load_live_execution_policy", return_value=control_plane._default_live_execution_policy()), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value={"enabled": False, "current_stage": "", "current_stage_config": {}}), \
             patch.object(control_plane, "_drawdown_velocity_snapshot", return_value={"lookback_minutes": 90, "recent_loss_usd": 0.0, "recent_net_result_usd": 0.0, "sample_count": 0}), \
             patch.object(control_plane, "_oracle_stability_snapshot", return_value={"enabled": True, "score": 0.5, "state": "critical", "sample_count": 5, "transition_count": 3, "confidence_span": 0.22}), \
             patch.object(control_plane, "append_audit"):
            result = control_plane._evaluate_go_live_hardening(
                source="signal-webhook",
                provider="mt5",
                account_id="acct-1",
                symbol="EURUSD",
                side="buy",
                requested_notional_usd=7.0,
                confidence=0.91,
                live_requested=True,
                purpose="execute",
            )

        self.assertEqual(result["status"], "blocked")
        self.assertIn("oracle_stability_blocked", result["reasons"])
        self.assertEqual(result["oracle_stability"]["state"], "critical")

    def test_evaluate_go_live_hardening_blocks_drawdown_velocity(self) -> None:
        provider_policy = control_plane._default_live_execution_policy()

        with patch.object(control_plane, "_load_live_execution_policy", return_value=provider_policy), \
             patch.object(control_plane, "_resolve_provider_micro_live", return_value={
                 "enabled": True,
                 "current_stage": "micro_risk",
                 "current_stage_config": {
                     "hardening_overrides": {
                         "drawdown_velocity": {
                             "enabled": True,
                             "lookback_minutes": 90,
                             "warn_loss_usd": 30.0,
                             "block_loss_usd": 50.0,
                             "warn_loss_pct_of_equity": 0.2,
                             "block_loss_pct_of_equity": 0.3,
                             "require_human_on_warning": True,
                         }
                     }
                 },
             }), \
             patch.object(control_plane, "_account_live_exposure_snapshot", return_value={"exposure_known": True, "equity_usd": 10000.0, "projected_total_exposure_pct": 5.0, "projected_symbol_exposure_pct": 5.0}), \
             patch.object(control_plane, "_go_live_signal_loop_snapshot", return_value={"lookback_minutes": 20, "repeat_count": 0, "same_source_repeat_count": 0, "blocked_repeat_count": 0}), \
             patch.object(control_plane, "_kill_switch_state", return_value={"active": False, "stats": {}}), \
             patch.object(control_plane, "_kill_switch_thresholds", return_value={"max_drawdown_intraday": 1500.0}), \
             patch.object(control_plane, "_recent_pending_live_approval_count", return_value=0), \
             patch.object(control_plane, "_drawdown_velocity_snapshot", return_value={"lookback_minutes": 90, "recent_loss_usd": 55.0, "recent_net_result_usd": -55.0, "sample_count": 2}), \
             patch.object(control_plane, "_oracle_stability_snapshot", return_value={"enabled": True, "score": 1.0, "state": "stable", "sample_count": 5, "transition_count": 0, "confidence_span": 0.01}), \
             patch.object(control_plane, "append_audit"):
            result = control_plane._evaluate_go_live_hardening(
                source="signal-webhook",
                provider="mt5",
                account_id="acct-1",
                symbol="EURUSD",
                side="buy",
                requested_notional_usd=15.0,
                confidence=0.91,
                live_requested=True,
                purpose="execute",
            )

        self.assertEqual(result["status"], "blocked")
        self.assertIn("drawdown_velocity_blocked", result["reasons"])
        self.assertTrue(result["drawdown_velocity"]["blocked"])


if __name__ == "__main__":
    unittest.main()
