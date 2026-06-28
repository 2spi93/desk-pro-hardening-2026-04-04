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
    assert "dedicated_go_phrase_for_side" in _SRC
    assert "GO renew BingX autonomous proof side=%s" in _SRC
    assert "PROOF_RENEWAL_EXECUTE" in _SRC


def test_runner_passes_side_into_readiness_check():
    assert 'SIDE="$SIDE" bash "$SCRIPT_DIR/bingx_proof_cycle_readiness_check.sh"' in _SRC


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


def test_runner_generates_reality_gap():
    # PORTE 2.4: the cycle triggers the reality_gap replay/ingest (3rd proof stream)
    assert "/v1/execution/reality-gap/" in _SRC
    # no calibration/training side effects on a single proof trade (quotes are
    # backslash-escaped inside the curl --data heredoc, so match loosely)
    assert "apply_calibration" in _SRC and "train_brain" in _SRC


def test_intent_live_context_forwards_proof_markers():
    # PORTE 2.5: _intent_live_execution_context whitelists fields; it MUST forward
    # proof_renewal/proof_cycle_id or D1's MARKET-force never reaches the router.
    main_src = (_ROOT / "apps" / "control_plane" / "main.py").read_text(encoding="utf-8")
    import ast
    tree = ast.parse(main_src)
    fn = next((n for n in ast.walk(tree)
               if isinstance(n, ast.FunctionDef) and n.name == "_intent_live_execution_context"), None)
    assert fn is not None
    body = ast.get_source_segment(main_src, fn)
    assert '"proof_renewal"' in body and '"proof_cycle_id"' in body


def test_control_plane_releases_risk_after_local_lock_only():
    main_src = (_ROOT / "apps" / "control_plane" / "main.py").read_text(encoding="utf-8")
    readiness_src = (_ROOT / "scripts" / "bingx_proof_cycle_readiness_check.sh").read_text(encoding="utf-8")
    assert "_local_execution_lock_snapshot" in main_src
    assert "blocked_by_local_lock" in main_src
    assert "_release_intent_risk_budget" in main_src
    assert "/v1/checks/pre-trade/release" in main_src
    assert "pre_risk_lock" in main_src
    assert "if exc.status_code == 423" in main_src
    assert "intent_blocked_by_local_lock" in main_src
    assert "intent_risk_budget_released_after_local_lock" in main_src
    assert "local_execution_lock" in readiness_src
    assert "local_execution_lock_active" in readiness_src


def test_control_plane_records_structured_execution_router_api_errors():
    main_src = (_ROOT / "apps" / "control_plane" / "main.py").read_text(encoding="utf-8")
    assert "api_error_recorded" in main_src
    assert '"endpoint": execution_endpoint' in main_src
    assert '"http_status": execution_response.status_code' in main_src
    assert '"upstream_detail": detail' in main_src
    assert '"cycle_id": str(live_hint.get("proof_cycle_id") or "")' in main_src


def test_runner_verifies_actual_fill():
    # PORTE 2.5: 'executed' status is not enough — the runner must verify a fill
    assert "assert_fill_persisted" in _SRC
    assert "no canonical fill persisted" in _SRC


def test_legacy_endpoint_fenced_for_autonomous_bingx():
    reason = pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-1", {"status": "finalized", "net_result_usd": 5.0},
        load_outcome=lambda d: {"source": "intent", "provider": "bingx", "status": "pending"},
    )
    assert reason == "use_proof_finalizer_for_autonomous_bingx_rail"
