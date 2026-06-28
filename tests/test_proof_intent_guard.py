"""PORTE 2.1 contract tests for the autonomous intent execution guard.

Pure, no DB/market. Loads the module by path. The runner must abort unless the
intent really executed a live order.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parents[1] / "apps" / "control_plane" / "proof_intent_guard.py"
_spec = importlib.util.spec_from_file_location("proof_intent_guard", _MOD)
g = importlib.util.module_from_spec(_spec)
sys.modules["proof_intent_guard"] = g
_spec.loader.exec_module(g)


def test_executed_live_with_order_id_is_ok():
    resp = {"status": "executed_in_live_mode", "order": {"order_id": "2067...", "status": "filled"}}
    assert g.intent_not_executed_reason(resp) is None


def test_rejected_by_risk_aborts_with_reasons():
    resp = {"status": "rejected_by_risk", "risk_decision": {"reasons": ["slippage_limit_exceeded"]}}
    r = g.intent_not_executed_reason(resp)
    assert r and "rejected_by_risk" in r and "slippage_limit_exceeded" in r


def test_rejected_preflight_aborts():
    assert g.intent_not_executed_reason({"status": "rejected_preflight"}).startswith("intent_not_executed")


def test_waiting_opportunity_gate_aborts():
    assert "accepted_waiting_opportunity_gate" in g.intent_not_executed_reason(
        {"status": "accepted_waiting_opportunity_gate"})


def test_waiting_human_approval_aborts():
    assert "accepted_waiting_human_or_higher_mode" in g.intent_not_executed_reason(
        {"status": "accepted_waiting_human_or_higher_mode"})


def test_paper_mode_aborts():
    # a paper execution is NOT canonical live proof -> abort
    assert "executed_in_paper_mode" in g.intent_not_executed_reason(
        {"status": "executed_in_paper_mode", "order": {"order_id": "x"}})


def test_blocked_by_local_lock_aborts_explicitly():
    reason = g.intent_not_executed_reason(
        {"status": "blocked_by_local_lock", "risk_decision": {"reasons": ["blocked_by_local_lock"]}}
    )
    assert reason and "blocked_by_local_lock" in reason


def test_executed_without_order_id_aborts():
    assert g.intent_not_executed_reason({"status": "executed_in_live_mode", "order": {}}) == "executed_status_without_order_id"


def test_executed_live_unknown_order_status_aborts():
    resp = {"status": "executed_in_live_mode", "order": {"order_id": "2067...", "status": "unknown"}}
    assert g.intent_not_executed_reason(resp) == "executed_status_without_canonical_fill_status:unknown"


def test_executed_live_open_order_status_aborts():
    resp = {"status": "executed_in_live_mode", "order": {"order_id": "2067...", "status": "open"}}
    assert g.intent_not_executed_reason(resp) == "executed_status_without_canonical_fill_status:open"


def test_unparseable_aborts():
    assert g.intent_not_executed_reason(None) == "unparseable_intent_response"
    assert g.intent_not_executed_reason("not a dict") == "unparseable_intent_response"
