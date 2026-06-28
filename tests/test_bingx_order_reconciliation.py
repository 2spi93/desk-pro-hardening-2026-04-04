from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


_MOD = Path(__file__).resolve().parents[1] / "apps" / "broker_adapter" / "main.py"
_ROOT = _MOD.parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
_spec = importlib.util.spec_from_file_location("broker_adapter_main", _MOD)
ba = importlib.util.module_from_spec(_spec)
sys.modules["broker_adapter_main"] = ba
_spec.loader.exec_module(ba)


def test_bingx_order_trace_preserves_string_order_id_and_client_id():
    trace = ba._bingx_order_trace(
        {
            "orderID": "12345678901234567890",
            "orderId": 12345678901234567890,
            "clientOrderId": "txt-proof-1",
            "status": "FILLED",
        },
        parser_branch="direct_payload",
    )

    assert trace["order_id"] == "12345678901234567890"
    assert trace["order_id_numeric_seen"] is True
    assert trace["order_id_string_seen"] is True
    assert trace["client_order_id"] == "txt-proof-1"
    assert trace["raw_status"] == "FILLED"


def test_bingx_order_snapshot_adds_reconciliation_trace():
    snapshot = ba._bingx_order_snapshot(
        {
            "orderID": "order-string",
            "clientOrderId": "client-1",
            "status": "NEW",
        },
        symbol="BTC-USDT",
        side="sell",
        requested_notional_usd=7.5,
    )

    assert snapshot["status"] == "open"
    assert snapshot["reconciliation"]["final_classification"] == "open"
    assert snapshot["reconciliation"]["trace"]["order_id"] == "order-string"
    assert snapshot["reconciliation"]["trace"]["client_order_id"] == "client-1"


def test_bingx_extract_items_recurses_into_common_envelopes():
    payload = {"data": {"orders": [{"orderID": "a"}, {"orderID": "b"}]}}

    assert ba._bingx_extract_items(payload, "orders", "data", "list") == [
        {"orderID": "a"},
        {"orderID": "b"},
    ]


def test_bingx_position_amount_uses_first_nonzero_amount():
    assert ba._bingx_position_amount({"positionAmt": "0", "holdVolume": "-0.002"}) == -0.002
    assert ba._bingx_position_amount({"positionAmt": "0"}) == 0.0
