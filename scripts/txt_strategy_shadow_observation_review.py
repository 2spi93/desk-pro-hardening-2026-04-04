#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_JSONL = Path("/opt/txt/var/proof_renewal/strategy_shadow_observation_24h_20260630T092735Z.jsonl")
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")


def parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return numeric if numeric == numeric else default


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * pct) - 1))
    return round(ordered[index], 8)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            if isinstance(payload, dict):
                rows.append(payload)
    return rows


def opportunity_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("selected_strategy_id") or "UNKNOWN"),
        str(row.get("side") or "UNKNOWN"),
        str(row.get("market_regime") or "UNKNOWN"),
    )


def group_opportunity_episodes(rows: list[dict[str, Any]], *, max_gap_minutes: float) -> list[dict[str, Any]]:
    episodes: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for row in rows:
        if row.get("decision") != "OPPORTUNITY":
            current = None
            continue
        scan_at = parse_time(row.get("scan_at") or row.get("observed_at"))
        key = opportunity_key(row)
        continue_current = False
        if current and current.get("key") == list(key) and scan_at:
            last_at = parse_time(current.get("last_scan_at"))
            if last_at and (scan_at - last_at).total_seconds() <= max_gap_minutes * 60.0:
                continue_current = True
        if not continue_current:
            current = {
                "episode_id": f"shadow-episode-{len(episodes) + 1:04d}",
                "key": list(key),
                "strategy_id": key[0],
                "side": key[1],
                "market_regime": key[2],
                "first_scan_at": row.get("scan_at") or row.get("observed_at"),
                "last_scan_at": row.get("scan_at") or row.get("observed_at"),
                "first_latest_bar_at": row.get("latest_bar_at"),
                "last_latest_bar_at": row.get("latest_bar_at"),
                "scan_count": 0,
                "max_lcb_bps": None,
                "max_net_edge_bps": None,
                "snapshot_digests": [],
            }
            episodes.append(current)
        current["scan_count"] += 1
        current["last_scan_at"] = row.get("scan_at") or row.get("observed_at")
        current["last_latest_bar_at"] = row.get("latest_bar_at")
        current["max_lcb_bps"] = max(
            to_float(current.get("max_lcb_bps"), float("-inf")),
            to_float(row.get("edge_lower_confidence_bound_bps"), float("-inf")),
        )
        current["max_net_edge_bps"] = max(
            to_float(current.get("max_net_edge_bps"), float("-inf")),
            to_float(row.get("net_expected_edge_bps"), float("-inf")),
        )
        digest = str(row.get("snapshot_digest") or row.get("snapshot_id") or "").strip()
        if digest:
            current["snapshot_digests"].append(digest)
    for episode in episodes:
        first = parse_time(episode.get("first_scan_at"))
        last = parse_time(episode.get("last_scan_at"))
        episode["duration_minutes"] = round((last - first).total_seconds() / 60.0, 6) if first and last else None
        episode["snapshot_digest_count"] = len(set(episode.pop("snapshot_digests", [])))
        if episode["max_lcb_bps"] == float("-inf"):
            episode["max_lcb_bps"] = None
        if episode["max_net_edge_bps"] == float("-inf"):
            episode["max_net_edge_bps"] = None
    return episodes


def build_review(rows: list[dict[str, Any]], *, episode_gap_minutes: float = 5.0) -> dict[str, Any]:
    opportunities = [row for row in rows if row.get("decision") == "OPPORTUNITY"]
    no_opportunities = [row for row in rows if row.get("decision") != "OPPORTUNITY"]
    episodes = group_opportunity_episodes(rows, max_gap_minutes=episode_gap_minutes)
    episode_durations = [to_float(item.get("duration_minutes")) for item in episodes if item.get("duration_minutes") is not None]
    opportunity_by_strategy = Counter(str(row.get("selected_strategy_id") or "UNKNOWN") for row in opportunities)
    dominant_count = max(opportunity_by_strategy.values()) if opportunity_by_strategy else 0
    lags = [to_float(row.get("market_data_lag_seconds")) for row in rows if row.get("market_data_lag_seconds") is not None]
    basis = [to_float(row.get("venue_basis_bps")) for row in rows if row.get("venue_basis_bps") is not None]
    opp_lcbs = [to_float(row.get("edge_lower_confidence_bound_bps")) for row in opportunities if row.get("edge_lower_confidence_bound_bps") is not None]
    opp_nets = [to_float(row.get("net_expected_edge_bps")) for row in opportunities if row.get("net_expected_edge_bps") is not None]
    return {
        "schema_version": "txt-strategy-shadow-observation-review/v1",
        "rows": len(rows),
        "first_scan": rows[0].get("scan_at") if rows else None,
        "latest_scan": rows[-1].get("scan_at") if rows else None,
        "raw_candidate_scans": len(opportunities),
        "unique_opportunity_episodes": len(episodes),
        "cooldown_rejections": max(0, len(opportunities) - len(episodes)),
        "episode_gap_minutes": episode_gap_minutes,
        "median_episode_duration": round(statistics.median(episode_durations), 6) if episode_durations else None,
        "max_episode_duration": round(max(episode_durations), 6) if episode_durations else None,
        "strategy_concentration_pct": round((dominant_count / len(opportunities)) * 100.0, 6) if opportunities else 0.0,
        "decisions": dict(Counter(str(row.get("decision") or "UNKNOWN") for row in rows)),
        "regimes": dict(Counter(str(row.get("market_regime") or "UNKNOWN") for row in rows)),
        "opportunities_by_strategy": dict(opportunity_by_strategy),
        "opportunities_by_side": dict(Counter(str(row.get("side") or "UNKNOWN") for row in opportunities)),
        "opportunities_by_regime": dict(Counter(str(row.get("market_regime") or "UNKNOWN") for row in opportunities)),
        "rejection_reasons": dict(Counter(reason for row in no_opportunities for reason in (row.get("rejection_reasons") or []))),
        "data_quality": {
            "warmup_false": sum(1 for row in rows if row.get("warmup_complete") is not True),
            "missing_nonzero": sum(1 for row in rows if (row.get("missing_bar_count") or 0) != 0),
            "duplicate_nonzero": sum(1 for row in rows if (row.get("duplicate_bar_count") or 0) != 0),
            "lag_sec_median": round(statistics.median(lags), 8) if lags else None,
            "lag_sec_p95": percentile(lags, 0.95),
        },
        "venue_basis": {
            "available": len(basis),
            "unavailable": sum(1 for row in rows if row.get("venue_basis_status") != "available"),
            "basis_bps_median": round(statistics.median(basis), 8) if basis else None,
            "basis_bps_min": round(min(basis), 8) if basis else None,
            "basis_bps_max": round(max(basis), 8) if basis else None,
        },
        "edge_distribution_opportunities": {
            "net_median": round(statistics.median(opp_nets), 8) if opp_nets else None,
            "net_min": round(min(opp_nets), 8) if opp_nets else None,
            "net_max": round(max(opp_nets), 8) if opp_nets else None,
            "lcb_median": round(statistics.median(opp_lcbs), 8) if opp_lcbs else None,
            "lcb_min": round(min(opp_lcbs), 8) if opp_lcbs else None,
            "lcb_max": round(max(opp_lcbs), 8) if opp_lcbs else None,
        },
        "episodes": episodes,
        "non_actions": ["no_broker_call", "no_order", "no_signal_consumption", "no_campaign_authorization"],
        "verdict": "CANARY_SIGNAL_EPISODES_AVAILABLE" if episodes else "STRATEGY_SELECTIVE_CONTINUE_OBSERVATION",
    }


def format_text(report: dict[str, Any]) -> str:
    return (
        f"STRATEGY_SHADOW_REVIEW raw_scans={report.get('raw_candidate_scans')} "
        f"episodes={report.get('unique_opportunity_episodes')} "
        f"cooldown_rejections={report.get('cooldown_rejections')} "
        f"concentration_pct={report.get('strategy_concentration_pct')} "
        f"verdict={report.get('verdict')}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Review append-only Strategy Brain shadow observations and group persistent scans into episodes.")
    parser.add_argument("--input-jsonl", default=str(DEFAULT_JSONL))
    parser.add_argument("--episode-gap-minutes", type=float, default=5.0)
    parser.add_argument("--output", default="")
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    input_path = Path(args.input_jsonl)
    report = build_review(load_jsonl(input_path), episode_gap_minutes=max(1.0, args.episode_gap_minutes))
    report["source_jsonl"] = str(input_path)
    if not args.no_write:
        output = Path(args.output) if args.output else DEFAULT_OUT_DIR / f"{input_path.stem}.episode_review.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["output_path"] = str(output)
    if args.text:
        print(format_text(report))
        if report.get("output_path"):
            print(f"review: {report['output_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
