"""D1 contract tests for the autonomous proof-renewal order shape.

Pure unit tests: no DB, no market, no router boot. Loads the standalone module
by path. Validates SPEC_D1_DETERMINISTIC_FILL.md.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_MOD = Path(__file__).resolve().parents[1] / "apps" / "execution_router" / "proof_order_shape.py"
_spec = importlib.util.spec_from_file_location("proof_order_shape", _MOD)
pos = importlib.util.module_from_spec(_spec)
sys.modules["proof_order_shape"] = pos
_spec.loader.exec_module(pos)


def _base(**over):
    p = {"proof_renewal": True, "decision_id": "dec-1", "proof_cycle_id": "cyc-1",
         "side": "sell", "estimated_notional_usd": 7.5}
    p.update(over)
    return p


def test_non_proof_order_returns_none():
    assert pos.resolve_proof_renewal_order_shape({"side": "sell", "estimated_notional_usd": 50}) is None


def test_accepts_market_taker_shape():
    shape = pos.resolve_proof_renewal_order_shape(_base())
    assert shape == {"order_type": "MARKET", "proof_cycle_id": "cyc-1", "decision_id": "dec-1"}


def test_forces_market_even_with_execution_hint():
    # an execution hint that would normally be passive is irrelevant -> MARKET
    shape = pos.resolve_proof_renewal_order_shape(_base(execution_hint="move_to_mid"))
    assert shape["order_type"] == "MARKET"


def test_refuses_passive_limit():
    with pytest.raises(ValueError, match="passive LIMIT"):
        pos.resolve_proof_renewal_order_shape(_base(order_type="LIMIT"))


def test_marketable_limit_hint_not_treated_as_passive():
    # explicit marketable flag is allowed (still forced to MARKET shape here)
    shape = pos.resolve_proof_renewal_order_shape(_base(order_type="LIMIT", marketable=True))
    assert shape["order_type"] == "MARKET"


def test_refuses_missing_decision_id():
    with pytest.raises(ValueError, match="decision_id"):
        pos.resolve_proof_renewal_order_shape(_base(decision_id=""))


def test_refuses_missing_proof_cycle_id():
    with pytest.raises(ValueError, match="proof_cycle_id"):
        pos.resolve_proof_renewal_order_shape(_base(proof_cycle_id=""))


def test_refuses_notional_over_cap():
    with pytest.raises(ValueError, match="exceeds cap"):
        pos.resolve_proof_renewal_order_shape(_base(estimated_notional_usd=8.0))


def test_refuses_zero_notional():
    with pytest.raises(ValueError, match="positive notional"):
        pos.resolve_proof_renewal_order_shape(_base(estimated_notional_usd=0))


def test_refuses_direct_broker_marker():
    with pytest.raises(ValueError, match="direct-broker"):
        pos.resolve_proof_renewal_order_shape(_base(operator_direct_broker=True))


def test_custom_cap_boundary():
    assert pos.resolve_proof_renewal_order_shape(_base(estimated_notional_usd=5.0), notional_cap=5.0)["order_type"] == "MARKET"
    with pytest.raises(ValueError):
        pos.resolve_proof_renewal_order_shape(_base(estimated_notional_usd=5.01), notional_cap=5.0)
