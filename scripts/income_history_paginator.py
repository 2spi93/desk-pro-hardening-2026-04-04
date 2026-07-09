#!/usr/bin/env python3
"""Complete income-history collection — FINANCIAL-TRUTH-ENGINE-001 debt 4 (cold).

The BingX income endpoint returns at most `limit` (100) events per window with no
verified cursor. A window returning exactly `limit` events may be SATURATED
(truncated). This collector does NOT assume a cursor: it recursively bisects any
window that hits the limit until every leaf window returns < limit, guaranteeing
no truncation. Dedup is by external_event_id; amounts are summed as Decimal (never
float). If a window cannot be split below the limit (all events within
min_window), coverage is NOT demonstrated -> fail-closed (complete=False).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Callable

DEFAULT_LIMIT = 100
DEFAULT_MIN_WINDOW_SEC = 60.0


def collect_income_complete(
    *,
    fetch_fn: Callable[[datetime, datetime], list[dict[str, Any]]],
    start: datetime,
    end: datetime,
    limit: int = DEFAULT_LIMIT,
    min_window_sec: float = DEFAULT_MIN_WINDOW_SEC,
    dedup_key: str = "external_event_id",
) -> dict[str, Any]:
    """Recursively bisect saturated windows until complete coverage is proven.

    Returns: events (deduped), count, slices_used, complete (bool),
    saturation_unresolved (list of windows that stayed >= limit at min size)."""
    events: dict[str, dict[str, Any]] = {}
    slices = 0
    saturation_unresolved: list[dict[str, str]] = []

    def recurse(ws: datetime, we: datetime) -> bool:
        nonlocal slices
        slices += 1
        page = fetch_fn(ws, we)
        n = len(page)
        if n < limit:
            for e in page:
                k = str(e.get(dedup_key))
                events[k] = e
            return True
        # exactly (or over) the limit -> potentially truncated
        window_sec = (we - ws).total_seconds()
        if window_sec <= min_window_sec:
            for e in page:
                k = str(e.get(dedup_key))
                events[k] = e
            saturation_unresolved.append({"window_start": ws.isoformat(), "window_end": we.isoformat(), "returned": str(n)})
            return False
        mid = ws + (we - ws) / 2
        left = recurse(ws, mid)
        right = recurse(mid, we)
        return left and right

    proven = recurse(start, end)
    complete = proven and not saturation_unresolved
    return {
        "events": list(events.values()),
        "count": len(events),
        "slices_used": slices,
        "complete": complete,
        "saturation_unresolved": saturation_unresolved,
    }


def sum_amounts_decimal(events: list[dict[str, Any]], field: str = "income") -> Decimal:
    """Sum amounts as Decimal from string values (never float), preserving venue
    precision. Missing/invalid values contribute 0."""
    total = Decimal("0")
    for e in events:
        raw = e.get(field)
        if raw is None:
            continue
        try:
            total += Decimal(str(raw))
        except (ValueError, ArithmeticError):
            continue
    return total
