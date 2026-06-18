"""Static wiring + rail-separation tests for the autonomous proof-renewal cycle.

No market, no DB, no app boot. Asserts the runner uses ONLY the autonomous rail
and the canonical finalizer, never the operator/legacy/marketable-limit paths.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_RUNNER = _ROOT / "scripts" / "bingx_autonomous_proof_renewal_v1.sh"
_PF = _ROOT / "apps" / "control_plane" / "proof_finalizer.py"

_spec = importlib.util.spec_from_file_location("proof_finalizer", _PF)
pf = importlib.util.module_from_spec(_spec)
sys.modules["proof_finalizer"] = pf
_spec.loader.exec_module(pf)

_SRC = _RUNNER.read_text(encoding="utf-8")


def test_runner_exists():
    assert _SRC, "proof-renewal runner missing"


def test_runner_routes_via_autonomous_intents():
    assert "/v1/intents/submit" in _SRC


def test_runner_uses_canonical_finalizer():
    assert "finalize_autonomous_bingx_outcome" in _SRC


def test_runner_has_no_direct_broker_order_path():
    assert "/v1/live/orders" not in _SRC


def test_runner_has_no_legacy_outcome_endpoint():
    assert "/v1/outcomes/" not in _SRC


def test_runner_has_no_marketable_limit_rail():
    assert "marketable-limit" not in _SRC.lower()
    assert "MARKETABLE_LIMIT_EXECUTE" not in _SRC


def test_runner_has_no_manual_sql():
    assert not re.search(r"\b(INSERT INTO|UPDATE)\s+decision_outcomes", _SRC)


def test_runner_execute_is_gated_by_dedicated_phrase():
    assert "GO renew BingX autonomous proof side=sell" in _SRC
    assert "PROOF_RENEWAL_EXECUTE" in _SRC


def test_runner_aborts_if_intent_not_executed():
    # PORTE 2.1: the runner must guard every intent with the execution check
    assert "intent_not_executed_reason" in _SRC
    assert "assert_executed" in _SRC


def test_runner_slippage_within_risk_policy():
    # PORTE 2.1 root-cause fix: max_slippage_bps must be <= risk policy (10)
    import re
    m = re.search(r'"max_slippage_bps"\s*:\s*(\d+)', _SRC)
    assert m and int(m.group(1)) <= 10, "runner max_slippage_bps must be <= 10"


def test_trap_uses_correct_flatten_endpoint():
    # PORTE 2.2 (A): the old bug posted flatten to BROKER_ADAPTER_URL (404). The
    # trap must hit the control-plane connector flatten with the operator token.
    assert "/v1/connectors/bingx/flatten" in _SRC
    assert 'BROKER_ADAPTER_URL' not in _SRC or "${CONTROL_PLANE_URL}/v1/connectors/bingx/flatten" in _SRC


def test_trap_cancels_orders_and_verifies_flat():
    # PORTE 2.2 (A): cancel orders + verify position=0/orders=0, HARD_FAIL otherwise
    assert "openOrders" in _SRC and "DELETE" in _SRC
    assert "HARD_FAIL" in _SRC
    assert '"positions": 0' in _SRC and '"orders": 0' in _SRC


def test_trap_does_not_swallow_errors():
    # PORTE 2.2 (A): no silent "done" — the old swallow pattern must be gone
    assert "2>/dev/null | tail -1 || true" not in _SRC
    assert "residual_flatten_done" not in _SRC


def test_proof_order_disables_auto_protection():
    # PORTE 2.2 (B): proof orders are clean MARKET takers (no auto TP/SL); auto
    # protection on the close leg was what made the exit return status=unknown.
    assert "auto_protection" in _SRC


def test_legacy_endpoint_fenced_for_autonomous_bingx():
    reason = pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-1", {"status": "finalized", "net_result_usd": 5.0},
        load_outcome=lambda d: {"source": "intent", "provider": "bingx", "status": "pending"},
    )
    assert reason == "use_proof_finalizer_for_autonomous_bingx_rail"
