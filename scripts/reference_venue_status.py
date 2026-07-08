#!/usr/bin/env python3
"""Pure classification of the reference-venue (Binance) symbol trading status
for the proof-renewal preflight.

Binance = market REFERENCE only (TXT executes on BingX), so an abnormal Binance
symbol status must not feed an artificial edge into a canary. Contract:

  TRADING        -> admissible reference
  CANCEL_ONLY /
  other known
  non-trading    -> not admissible (no new entry)
  unknown value  -> fail-closed + schema_drift (Binance added an enum we do not
                    yet model, e.g. SBE 3.5 changes)
  unfetched      -> fail-closed for the one-shot preflight (we require positive
                    confirmation of TRADING before a single supervised canary)

Pure/no I/O so it is unit-testable; the readiness probe fetches the status and
passes it here.
"""
from __future__ import annotations

from typing import Any

# The only status on which a new entry / fresh signal is admissible.
KNOWN_TRADABLE = {"TRADING"}

# Known Binance symbol statuses that are NOT admissible for a new entry. Price
# may still be observable, but no fresh signal may be built on them.
KNOWN_NOT_TRADABLE = {
    "HALT",
    "BREAK",
    "AUCTION_MATCH",
    "PRE_TRADING",
    "POST_TRADING",
    "END_OF_DAY",
    "CANCEL_ONLY",  # added by the 2026-07 Binance deployment / SBE 3.5
    "TRADING_SUSPENDED",
    "DELISTED",
    "SETTLING",
    "CLOSE",
}


def classify_reference_venue_status(status: Any, *, fetched: bool = True) -> dict[str, Any]:
    """Return an admissibility verdict for a reference-venue symbol status.

    Keys: admissible (bool), reason (str|None), schema_drift (bool),
    status (normalized str|None).
    """
    if not fetched or status is None:
        return {
            "admissible": False,
            "reason": "reference_venue_status_unavailable",
            "schema_drift": False,
            "status": None,
        }
    normalized = str(status).strip().upper()
    if normalized in KNOWN_TRADABLE:
        return {"admissible": True, "reason": None, "schema_drift": False, "status": normalized}
    if normalized in KNOWN_NOT_TRADABLE:
        return {
            "admissible": False,
            "reason": f"reference_venue_not_tradable:{normalized}",
            "schema_drift": False,
            "status": normalized,
        }
    return {
        "admissible": False,
        "reason": f"reference_venue_status_unknown:{normalized}",
        "schema_drift": True,
        "status": normalized,
    }
