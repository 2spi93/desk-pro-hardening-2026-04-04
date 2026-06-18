"""Contract tests for the D2 canonical outcome finalizer.

Pure unit tests: no DB, no market, no network. The finalizer's DB readers/writer
are injected with in-memory fakes. Validates SPEC_D2_CANONICAL_OUTCOME_FINALIZATION.md.
"""
from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path

_MOD_PATH = Path(__file__).resolve().parents[1] / "apps" / "control_plane" / "proof_finalizer.py"
_spec = importlib.util.spec_from_file_location("proof_finalizer", _MOD_PATH)
pf = importlib.util.module_from_spec(_spec)
sys.modules["proof_finalizer"] = pf  # so dataclasses can resolve __module__
_spec.loader.exec_module(pf)


# ----- helpers ----------------------------------------------------------------
def _fill(fill_id, *, venue="bingx", fill_type="live-broker", side="sell",
          notional=6.43, size=0.0001, slippage=2.0, latency=120, fees=0.0):
    return {
        "fill_id": fill_id, "venue": venue, "fill_type": fill_type, "side": side,
        "price": 64304.1, "size_base": size, "notional_usd": notional,
        "slippage_bps": slippage, "fill_latency_ms": latency,
        "payload": {"fees_usd": fees}, "filled_at": "2026-06-18T00:00:00+00:00",
    }


def _outcome(*, source="intent", provider="bingx", status="pending", metadata=None):
    return {
        "decision_id": "dec-1", "source": source, "provider": provider,
        "symbol": "BTCUSDT", "strategy_id": "ops", "regime": "n",
        "status": status, "metadata": metadata or {},
    }


class _Harness:
    def __init__(self, outcome=None, fills_by_decision=None, reality_gap=None):
        self.outcome = outcome
        self.fills_by_decision = fills_by_decision or {}
        self.reality_gap = reality_gap
        self.writes = []

    def load_outcome(self, decision_id):
        return self.outcome

    def load_fills(self, decision_id):
        return list(self.fills_by_decision.get(decision_id, []))

    def load_reality_gap(self, decision_id):
        return self.reality_gap

    def write_outcome(self, decision_id, existing, computed, metadata):
        self.writes.append({"decision_id": decision_id, "computed": computed, "metadata": metadata})

    def run(self, decision_id="dec-1", exit_decision_id=None):
        return pf.finalize_autonomous_bingx_outcome(
            decision_id,
            exit_decision_id=exit_decision_id,
            load_outcome=self.load_outcome,
            load_fills=self.load_fills,
            load_reality_gap=self.load_reality_gap,
            write_outcome=self.write_outcome,
        )


# ----- contract tests ---------------------------------------------------------
def test_happy_path_pending_to_finalized():
    h = _Harness(
        outcome=_outcome(),
        fills_by_decision={
            "dec-1": [_fill("entry-1", side="sell", notional=6.43, fees=0.003)],
            "exit-1": [_fill("exit-1", side="buy", notional=6.41, fees=0.003)],
        },
        reality_gap={"sample_id": "rg-1"},
    )
    res = h.run(exit_decision_id="exit-1")
    assert res.action == "finalized" and res.ok
    assert len(h.writes) == 1
    audit = h.writes[0]["metadata"]["proof_finalization"]
    assert audit["previous_status"] == "pending" and audit["next_status"] == "finalized"
    assert audit["reason"] == pf.REASON
    assert audit["evidence_refs"]["fill_ids"] == ["entry-1"]
    assert audit["evidence_refs"]["reality_gap_sample_id"] == "rg-1"
    assert res.computed["measurement_basis"] == "round_trip"
    # short pnl = entry_notional - exit_notional - fees = 6.43 - 6.41 - 0.006
    assert abs(res.computed["net_result_usd"] - (6.43 - 6.41 - 0.006)) < 1e-9


def test_missing_fill_refused():
    h = _Harness(outcome=_outcome(), fills_by_decision={})
    res = h.run()
    assert res.action == "refused" and res.reason == "no_canonical_fill"
    assert h.writes == []


def test_no_outcome_and_no_fills_refused():
    # no pending row AND no canonical fill -> nothing to finalize
    h = _Harness(outcome=None)
    res = h.run()
    assert res.action == "refused" and res.reason == "no_canonical_fill"
    assert h.writes == []


# ----- D2.3 create-if-missing (no pending decision_outcomes row) --------------
def test_create_from_fills_when_no_row():
    h = _Harness(
        outcome=None,  # autonomous path created no decision_outcomes row
        fills_by_decision={
            "dec-1": [_fill("entry-1", side="sell", notional=6.43, fees=0.002)],
            "exit-1": [_fill("exit-1", side="buy", notional=6.41, fees=0.002)],
        },
        reality_gap={"sample_id": "rg-1"},
    )
    res = h.run(exit_decision_id="exit-1")
    assert res.action == "finalized" and res.reason == "created_finalized_from_fills"
    assert len(h.writes) == 1
    audit = h.writes[0]["metadata"]["proof_finalization"]
    assert audit["previous_status"] == "absent" and audit["created_from_fills"] is True
    assert res.computed["measurement_basis"] == "round_trip"


def test_create_refused_without_exit_fill():
    h = _Harness(outcome=None, fills_by_decision={"dec-1": [_fill("entry-1")]})
    res = h.run()  # no exit_decision_id
    assert res.action == "refused" and res.reason == "exit_fill_required"
    assert h.writes == []


def test_create_refused_non_bingx_venue():
    h = _Harness(outcome=None, fills_by_decision={"dec-1": [_fill("e1", venue="bybit")],
                                                  "exit-1": [_fill("x1", venue="bybit", side="buy")]})
    res = h.run(exit_decision_id="exit-1")
    assert res.action == "refused" and res.reason == "no_canonical_fill"
    assert h.writes == []


def test_create_refused_non_live_broker():
    h = _Harness(outcome=None, fills_by_decision={"dec-1": [_fill("e1", fill_type="book")],
                                                  "exit-1": [_fill("x1", fill_type="book", side="buy")]})
    res = h.run(exit_decision_id="exit-1")
    assert res.action == "refused" and res.reason == "no_canonical_fill"
    assert h.writes == []


def test_create_refused_qty_mismatch_incoherent():
    h = _Harness(outcome=None, fills_by_decision={
        "dec-1": [_fill("entry-1", side="sell", size=0.0001)],
        "exit-1": [_fill("exit-1", side="buy", size=0.00005)],  # partial close -> not flat
    })
    res = h.run(exit_decision_id="exit-1")
    assert res.action == "refused" and res.reason == "round_trip_incoherent"
    assert h.writes == []


def test_create_refused_same_side_incoherent():
    h = _Harness(outcome=None, fills_by_decision={
        "dec-1": [_fill("entry-1", side="sell")],
        "exit-1": [_fill("exit-1", side="sell")],  # not opposite -> incoherent
    })
    res = h.run(exit_decision_id="exit-1")
    assert res.action == "refused" and res.reason == "round_trip_incoherent"
    assert h.writes == []


def test_rail_mismatch_refused_mt5():
    h = _Harness(outcome=_outcome(source="mt5", provider="mt5-bridge"),
                 fills_by_decision={"dec-1": [_fill("e1")]})
    res = h.run()
    assert res.action == "refused" and res.reason == "rail_mismatch"
    assert h.writes == []


def test_direct_broker_evidence_refused():
    # operator direct-broker fills never persist as live-broker/bingx rows for the
    # decision_id; simulate a non-canonical fill (paper book / wrong venue).
    h = _Harness(outcome=_outcome(),
                 fills_by_decision={"dec-1": [_fill("e1", fill_type="book"),
                                              _fill("e2", venue="bybit")]})
    res = h.run()
    assert res.action == "refused" and res.reason == "no_canonical_fill"
    assert h.writes == []


def test_duplicate_finalize_is_noop():
    h1 = _Harness(outcome=_outcome(),
                  fills_by_decision={"dec-1": [_fill("entry-1")]})
    first = h1.run()
    assert first.action == "finalized"
    finalized_meta = h1.writes[0]["metadata"]
    # second run: outcome now finalized with the same evidence hash
    h2 = _Harness(outcome=_outcome(status="finalized", metadata=finalized_meta),
                  fills_by_decision={"dec-1": [_fill("entry-1")]})
    second = h2.run()
    assert second.action == "noop" and second.reason == "already_finalized"
    assert h2.writes == []


def test_overwrite_finalized_refused():
    h1 = _Harness(outcome=_outcome(), fills_by_decision={"dec-1": [_fill("entry-1", notional=6.43)]})
    first = h1.run()
    finalized_meta = h1.writes[0]["metadata"]
    # different evidence (different notional -> different hash) on a finalized row
    h2 = _Harness(outcome=_outcome(status="finalized", metadata=finalized_meta),
                  fills_by_decision={"dec-1": [_fill("entry-1", notional=99.0)]})
    second = h2.run()
    assert second.action == "refused" and second.reason == "overwrite_finalized"
    assert h2.writes == []


def test_caller_supplied_numbers_have_no_entrypoint():
    # structural guarantee: the finalizer signature exposes no pnl/status/net_result.
    params = set(inspect.signature(pf.finalize_autonomous_bingx_outcome).parameters)
    for forbidden in ("pnl", "pnl_5m", "status", "net_result_usd", "slippage_real_bps", "fees_usd"):
        assert forbidden not in params
    # and a bogus 'pnl' inside fill payload is ignored: net_result comes from notionals
    h = _Harness(outcome=_outcome(),
                 fills_by_decision={"dec-1": [{**_fill("entry-1", side="sell", notional=6.43),
                                               "payload": {"fees_usd": 0.0, "pnl": 999.0}}],
                                    "exit-1": [_fill("exit-1", side="buy", notional=6.40)]})
    res = h.run(exit_decision_id="exit-1")
    assert res.computed["net_result_usd"] == round(6.43 - 6.40 - 0.0, 8)  # 999.0 ignored


def test_entry_only_basis_when_no_exit_fill():
    # without an exit fill the measurement is entry_only and net_result is None
    h = _Harness(outcome=_outcome(), fills_by_decision={"dec-1": [_fill("entry-1")]})
    res = h.run()  # no exit_decision_id
    assert res.action == "finalized"
    assert res.computed["measurement_basis"] == "entry_only"
    assert res.computed["net_result_usd"] is None


def test_require_round_trip_refuses_without_exit_fill():
    # D3: a proof cycle demands a complete round-trip; entry_only is refused
    h = _Harness(outcome=_outcome(), fills_by_decision={"dec-1": [_fill("entry-1")]})
    res = pf.finalize_autonomous_bingx_outcome(
        "dec-1", require_round_trip=True,
        load_outcome=h.load_outcome, load_fills=h.load_fills,
        load_reality_gap=h.load_reality_gap, write_outcome=h.write_outcome,
    )
    assert res.action == "refused" and res.reason == "exit_fill_required"
    assert h.writes == []


def test_require_round_trip_accepts_with_exit_fill():
    h = _Harness(
        outcome=_outcome(),
        fills_by_decision={"dec-1": [_fill("entry-1", side="sell", notional=6.43)],
                           "exit-1": [_fill("exit-1", side="buy", notional=6.40)]},
    )
    res = pf.finalize_autonomous_bingx_outcome(
        "dec-1", exit_decision_id="exit-1", require_round_trip=True,
        load_outcome=h.load_outcome, load_fills=h.load_fills,
        load_reality_gap=h.load_reality_gap, write_outcome=h.write_outcome,
    )
    assert res.action == "finalized" and res.computed["measurement_basis"] == "round_trip"


def test_legacy_fence_blocks_proof_rail_caller_finalize():
    # the fence helper flags legacy magic-endpoint finalize on an autonomous bingx row
    blocked = pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-1", {"status": "finalized", "net_result_usd": 5.0},
        load_outcome=lambda d: _outcome(),
    )
    assert blocked == "use_proof_finalizer_for_autonomous_bingx_rail"
    # but legacy finalize on a non proof-rail (e.g. mt5) decision is allowed
    allowed = pf.assert_legacy_finalize_not_for_proof_rail(
        "dec-2", {"status": "finalized"},
        load_outcome=lambda d: _outcome(source="mt5", provider="mt5-bridge"),
    )
    assert allowed is None
