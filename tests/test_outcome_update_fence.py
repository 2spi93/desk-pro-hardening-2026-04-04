"""Route-level proof that the legacy /v1/outcomes/{id}/update magic button is
fenced off from the autonomous BingX proof rail.

No market, no DB, no FastAPI app boot. Two checks:
  1. behavior: the fence helper refuses an autonomous-bingx finalize and lets
     legacy/MT5 (and non-finalize) calls through;
  2. wiring: the update_outcome endpoint calls the fence and raises 409 BEFORE
     any decision_outcomes INSERT (static source/AST inspection, repo style).
"""
from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_PF_PATH = _ROOT / "apps" / "control_plane" / "proof_finalizer.py"
_MAIN_PATH = _ROOT / "apps" / "control_plane" / "main.py"

_spec = importlib.util.spec_from_file_location("proof_finalizer", _PF_PATH)
pf = importlib.util.module_from_spec(_spec)
sys.modules["proof_finalizer"] = pf
_spec.loader.exec_module(pf)


def _outcome(source, provider, status="pending"):
    return {"source": source, "provider": provider, "status": status}


# ----- 1. behavior -----------------------------------------------------------
def test_fence_refuses_autonomous_bingx_finalize():
    reason = pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-1", {"status": "finalized", "net_result_usd": 5.0},
        load_outcome=lambda d: _outcome("intent", "bingx"),
    )
    assert reason == "use_proof_finalizer_for_autonomous_bingx_rail"


def test_fence_allows_legacy_mt5_finalize():
    assert pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-2", {"status": "finalized"},
        load_outcome=lambda d: _outcome("mt5", "mt5-bridge"),
    ) is None


def test_fence_allows_non_finalize_status_on_proof_rail():
    # only finalize is fenced; a pending/other update is not the truth-debt case
    assert pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-3", {"status": "pending"},
        load_outcome=lambda d: _outcome("intent", "bingx"),
    ) is None


def test_fence_allows_unknown_decision():
    assert pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-x", {"status": "finalized"}, load_outcome=lambda d: None,
    ) is None


# ----- 2. wiring (static) ----------------------------------------------------
def _update_outcome_source() -> str:
    tree = ast.parse(_MAIN_PATH.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "update_outcome":
            return ast.get_source_segment(_MAIN_PATH.read_text(encoding="utf-8"), node)
    raise AssertionError("update_outcome endpoint not found")


def test_endpoint_imports_fence():
    src = _MAIN_PATH.read_text(encoding="utf-8")
    assert "from apps.control_plane.proof_finalizer import assert_legacy_finalize_not_for_proof_rail" in src


def test_endpoint_fences_before_insert():
    body = _update_outcome_source()
    assert "assert_legacy_finalize_not_for_proof_rail" in body, "fence not called in endpoint"
    assert "status_code=409" in body, "fence does not raise 409"
    fence_at = body.index("assert_legacy_finalize_not_for_proof_rail")
    insert_at = body.index("INSERT INTO decision_outcomes")
    assert fence_at < insert_at, "fence must run BEFORE any decision_outcomes INSERT"
