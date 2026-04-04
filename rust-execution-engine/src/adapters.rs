use crate::types::{ExecutionRequest, RouteCandidate};

pub fn collect_route_candidates(request: &ExecutionRequest) -> Vec<RouteCandidate> {
    let mut candidates = request
        .route_hint
        .as_ref()
        .map(|hint| {
            let mut rows = hint.candidates.clone();
            if let Some(best) = hint.best.clone() {
                rows.push(best);
            }
            if let Some(backup) = hint.backup.clone() {
                rows.push(backup);
            }
            rows
        })
        .unwrap_or_default();

    if candidates.is_empty() {
        candidates.push(RouteCandidate {
            venue: request
                .preferred_venue
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "rust-sim".to_string()),
            instrument: request.symbol.clone(),
            spread_bps: request.max_spread_bps.max(1.0) * 0.6,
            available_depth_usd: (request.estimated_notional_usd * 1.8).max(2500.0),
            latency_ms: 9.0,
            fill_probability: 0.91,
            score: 0.75,
            best_bid: 0.0,
            best_ask: 0.0,
            last: 0.0,
            matching_rule: "price-time".to_string(),
            queue_priority_risk: 0.18,
            hidden_liquidity_ratio: 0.08,
            partial_fill_risk: 0.12,
            micro_latency_jitter_ms: 6.0,
            freshness_ms: 0.0,
            infra_health: 1.0,
            network_regime: "stable".to_string(),
            infra_factor: 1.0,
            reality_gap_profile_key: None,
        });
    }

    candidates.retain(|candidate| !candidate.venue.trim().is_empty());
    candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
    candidates.dedup_by(|left, right| left.venue == right.venue);
    candidates
}