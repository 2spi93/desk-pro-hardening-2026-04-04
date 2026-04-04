use crate::adapters::collect_route_candidates;
use crate::state::AppState;
use crate::types::{ArbPlan, ExecutionRequest, ExecutionResponse, FillEvent, HedgeGuard, MarketSnapshot, RealityGapExecutionSnapshot, RealityGapSample, RouteCandidate, RouteSelection};
use serde_json::json;

pub fn execute(state: &AppState, request: ExecutionRequest) -> ExecutionResponse {
    if let Some(runtime) = state.hft_runtime.as_ref() {
        runtime.record_request(&request, false);
    }
    build_execution_response(state, request, false)
}

pub fn preview(state: &AppState, request: ExecutionRequest) -> ExecutionResponse {
    if let Some(runtime) = state.hft_runtime.as_ref() {
        runtime.record_request(&request, true);
    }
    build_execution_response(state, request, true)
}

fn build_execution_response(state: &AppState, request: ExecutionRequest, preview_only: bool) -> ExecutionResponse {
    let candidates = collect_route_candidates(&request);
    let chosen = choose_route(&request, &candidates);
    let backup = choose_backup(&chosen, &candidates);
    let market_snapshot = request.market_snapshot.clone().or_else(|| build_market_snapshot(&candidates));
    let hedge_guard = evaluate_hedge_guard(state, &request, chosen.as_ref(), backup.as_ref(), market_snapshot.as_ref());
    let fills = if !preview_only && hedge_guard.allow_execution {
        simulate_fills(&request, chosen.as_ref())
    } else {
        Vec::new()
    };
    let expected_slippage_bps = estimate_slippage_bps(&request, chosen.as_ref());
    let fill_quality_score = estimate_fill_quality(&request, chosen.as_ref(), expected_slippage_bps);
    let arb_plan = build_arb_plan(&request, &candidates, market_snapshot.as_ref(), request.max_spread_bps);
    let mode = if arb_plan.as_ref().is_some_and(|plan| plan.executable) {
        "arb-scan"
    } else {
        "single-venue"
    };
    let source = request
        .route_hint
        .as_ref()
        .and_then(|hint| hint.source.clone())
        .unwrap_or_else(|| "rust-route-hint".to_string());
    let reason = request
        .route_hint
        .as_ref()
        .and_then(|hint| hint.reason.clone())
        .unwrap_or_else(|| {
            if hedge_guard.allow_execution {
                "preferred_or_best_candidate".to_string()
            } else {
                "hedge_guard_blocked".to_string()
            }
        });
    let reality_gap_sample = if !preview_only && hedge_guard.allow_execution {
        build_reality_gap_sample(
            &request,
            chosen.as_ref(),
            &fills,
            expected_slippage_bps,
            fill_quality_score,
            mode,
            &source,
            &reason,
        )
    } else {
        None
    };

    ExecutionResponse {
        decision_id: request.decision_id.clone(),
        engine: state.config.engine_name.clone(),
        preview_only,
        accepted: hedge_guard.allow_execution,
        status: if hedge_guard.allow_execution {
            if preview_only { "preview-ready".to_string() } else { "accepted".to_string() }
        } else {
            if preview_only { "preview-blocked".to_string() } else { "blocked".to_string() }
        },
        route: RouteSelection {
            chosen,
            backup,
            mode: mode.to_string(),
            source,
            reason,
        },
        route_candidates: candidates,
        market_snapshot,
        fills,
        expected_slippage_bps,
        fill_quality_score,
        hedge_guard,
        arb_plan,
        processing_latency_ms: state.config.default_latency_ms,
        reality_gap_sample,
    }
}

fn build_reality_gap_sample(
    request: &ExecutionRequest,
    chosen: Option<&RouteCandidate>,
    fills: &[FillEvent],
    expected_slippage_bps: f64,
    fill_quality_score: f64,
    route_mode: &str,
    route_source: &str,
    route_reason: &str,
) -> Option<RealityGapSample> {
    let candidate = chosen?;
    if fills.is_empty() {
        return None;
    }

    let total_notional_usd: f64 = fills.iter().map(|fill| fill.notional_usd.max(0.0)).sum();
    let realized_fill_ratio = if request.estimated_notional_usd > 0.0 {
        (total_notional_usd / request.estimated_notional_usd).clamp(0.0, 1.25)
    } else {
        0.0
    };
    let weighted_slippage_bps = weighted_fill_metric(fills, |fill| fill.slippage_bps).unwrap_or(expected_slippage_bps);
    let weighted_impact_bps = weighted_fill_metric(fills, |fill| fill.impact_bps).unwrap_or(expected_slippage_bps * 0.45);
    let weighted_queue_risk = weighted_fill_metric(fills, |fill| fill.queue_priority_risk).unwrap_or(candidate.queue_priority_risk);
    let realized_latency_ms = fills.iter().map(|fill| fill.latency_ms as f64).fold(0.0, f64::max);
    let predicted_latency_ms = request.execution_delay_ms as f64 + candidate.latency_ms.max(0.0);
    let predicted_impact_bps = expected_slippage_bps * 0.45;
    let regime = extract_request_regime(request);
    let metadata = request.metadata.clone().unwrap_or_else(|| json!({}));

    Some(RealityGapSample {
        sample_id: format!("rg-native-{}", request.decision_id),
        decision_id: request.decision_id.clone(),
        symbol: request.symbol.clone(),
        venue: candidate.venue.clone(),
        regime,
        side: request.side.clone(),
        predicted: RealityGapExecutionSnapshot {
            slippage_bps: Some(expected_slippage_bps),
            fill_probability: Some(candidate.fill_probability),
            fill_ratio: None,
            latency_ms: Some(predicted_latency_ms),
            impact_bps: Some(predicted_impact_bps),
            queue_ahead_qty: Some(candidate.queue_priority_risk),
            metadata: json!({
                "matching_rule": candidate.matching_rule,
                "hidden_liquidity_ratio": candidate.hidden_liquidity_ratio,
                "partial_fill_risk": candidate.partial_fill_risk,
                "micro_latency_jitter_ms": candidate.micro_latency_jitter_ms,
                "profile_key": candidate.reality_gap_profile_key,
            }),
        },
        realized: RealityGapExecutionSnapshot {
            slippage_bps: Some(weighted_slippage_bps),
            fill_probability: None,
            fill_ratio: Some(realized_fill_ratio),
            latency_ms: Some(realized_latency_ms),
            impact_bps: Some(weighted_impact_bps),
            queue_ahead_qty: Some(weighted_queue_risk),
            metadata: json!({
                "fill_count": fills.len(),
                "fill_quality_score": fill_quality_score,
            }),
        },
        failure_source: None,
        failure_reasons: Vec::new(),
        calibration_action: None,
        metadata: json!({
            "engine": "rust-execution-engine",
            "route_mode": route_mode,
            "route_source": route_source,
            "route_reason": route_reason,
            "request_metadata": metadata,
        }),
        created_at: String::new(),
    })
}

fn weighted_fill_metric<F>(fills: &[FillEvent], selector: F) -> Option<f64>
where
    F: Fn(&FillEvent) -> f64,
{
    let total_weight: f64 = fills.iter().map(|fill| fill.notional_usd.max(0.0)).sum();
    if total_weight <= f64::EPSILON {
        return None;
    }
    let weighted_sum: f64 = fills
        .iter()
        .map(|fill| selector(fill) * fill.notional_usd.max(0.0))
        .sum();
    Some(weighted_sum / total_weight)
}

fn extract_request_regime(request: &ExecutionRequest) -> String {
    let metadata = request.metadata.as_ref();
    metadata
        .and_then(|value| value.get("reality_gap_regime"))
        .and_then(|value| value.as_str())
        .or_else(|| metadata.and_then(|value| value.get("regime")).and_then(|value| value.as_str()))
        .or_else(|| {
            metadata
                .and_then(|value| value.get("predictor_context"))
                .and_then(|value| value.get("regime"))
                .and_then(|value| value.as_str())
        })
        .unwrap_or("UNKNOWN")
        .to_uppercase()
}

fn choose_route(request: &ExecutionRequest, candidates: &[RouteCandidate]) -> Option<RouteCandidate> {
    if let Some(preferred) = request.preferred_venue.as_ref() {
        if let Some(candidate) = candidates.iter().find(|row| row.venue == *preferred) {
            return Some(candidate.clone());
        }
    }
    candidates.first().cloned()
}

fn choose_backup(chosen: &Option<RouteCandidate>, candidates: &[RouteCandidate]) -> Option<RouteCandidate> {
    candidates
        .iter()
        .find(|candidate| match chosen.as_ref() {
            Some(selected) => selected.venue != candidate.venue,
            None => true,
        })
        .cloned()
}

fn evaluate_hedge_guard(
    state: &AppState,
    request: &ExecutionRequest,
    chosen: Option<&RouteCandidate>,
    backup: Option<&RouteCandidate>,
    market_snapshot: Option<&MarketSnapshot>,
) -> HedgeGuard {
    let mut reason_codes = Vec::new();
    let available_depth_usd = chosen.map(|candidate| candidate.available_depth_usd).unwrap_or(0.0);
    let observed_spread_bps = chosen.map(|candidate| candidate.spread_bps).unwrap_or(0.0);
    let required_depth_usd = (request.estimated_notional_usd.max(0.0) * state.config.hedge_depth_ratio).max(250.0);
    let backup_depth_usd = backup.map(|candidate| candidate.available_depth_usd).unwrap_or(0.0);
    let fill_probability = chosen.map(|candidate| candidate.fill_probability).unwrap_or(0.0);
    let deviation_bps = market_snapshot.map(|snapshot| snapshot.deviation_bps).unwrap_or(0.0);

    if request.estimated_notional_usd <= 0.0 {
        reason_codes.push("invalid_notional".to_string());
    }
    if available_depth_usd + f64::EPSILON < required_depth_usd {
        reason_codes.push("insufficient_depth".to_string());
    }
    if backup_depth_usd + f64::EPSILON < request.estimated_notional_usd.max(0.0) {
        reason_codes.push("hedge_depth_insufficient".to_string());
    }
    if fill_probability < 0.55 {
        reason_codes.push("fill_probability_too_low".to_string());
    }
    if request.max_spread_bps > 0.0 && observed_spread_bps > request.max_spread_bps * 1.2 {
        reason_codes.push("spread_guard_exceeded".to_string());
    }
    if deviation_bps > 35.0 {
        reason_codes.push("market_snapshot_divergence".to_string());
    }

    HedgeGuard {
        allow_execution: reason_codes.is_empty(),
        reason_codes,
        required_depth_usd,
        available_depth_usd,
        observed_spread_bps,
        max_spread_bps: request.max_spread_bps,
    }
}

fn simulate_fills(request: &ExecutionRequest, chosen: Option<&RouteCandidate>) -> Vec<FillEvent> {
    let venue = chosen
        .map(|candidate| candidate.venue.clone())
        .unwrap_or_else(|| "rust-sim".to_string());
    let spread_bps = chosen.map(|candidate| candidate.spread_bps).unwrap_or(request.max_spread_bps.max(1.0));
    let matching_rule = chosen
        .map(|candidate| if candidate.matching_rule.trim().is_empty() { "price-time".to_string() } else { candidate.matching_rule.clone() })
        .unwrap_or_else(|| "price-time".to_string());
    let queue_priority_risk = chosen.map(|candidate| candidate.queue_priority_risk.clamp(0.0, 0.95)).unwrap_or(0.18);
    let hidden_liquidity_ratio = chosen.map(|candidate| candidate.hidden_liquidity_ratio.clamp(0.0, 0.5)).unwrap_or(0.08);
    let partial_fill_risk = chosen.map(|candidate| candidate.partial_fill_risk.clamp(0.0, 0.95)).unwrap_or(0.12);
    let latency_jitter_ms = chosen.map(|candidate| candidate.micro_latency_jitter_ms.max(0.0) as u64).unwrap_or(6);
    let midpoint = chosen
        .map(midpoint)
        .filter(|value| *value > 0.0)
        .unwrap_or(1.0);
    let direction = if request.side.eq_ignore_ascii_case("sell") { -1.0 } else { 1.0 };
    let slices = [0.58, 0.27, 0.15];

    slices
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            let pressure = (index as f64 + 1.0) / slices.len() as f64;
            let queue_penalty = 1.0 + queue_priority_risk * (0.28 + pressure * 0.18);
            let hidden_bonus = 1.0 - hidden_liquidity_ratio * if index == 0 { 0.22 } else { 0.08 };
            let matching_penalty = if matching_rule == "pro-rata-lite" {
                1.06
            } else if matching_rule == "price-time-auction" {
                if index == 0 { 0.96 } else { 1.12 }
            } else {
                1.0
            };
            let price_offset = midpoint * (spread_bps / 10_000.0) * 0.35 * pressure * direction * queue_penalty * matching_penalty * hidden_bonus;
            let mut slice_weight = *weight * (1.0 - partial_fill_risk * (0.08 + pressure * 0.12));
            if matching_rule == "price-time-auction" && index == 0 {
                slice_weight *= 1.08;
            }
            slice_weight = slice_weight.clamp(0.04, 0.7);
            let notional_usd = request.estimated_notional_usd.max(0.0) * slice_weight;
            let realized_slippage_bps = (spread_bps * 0.42 * pressure * queue_penalty * hidden_bonus).max(0.0);
            FillEvent {
                fill_id: format!("{}-fill-{}", request.decision_id, index + 1),
                venue: venue.clone(),
                price: (midpoint + price_offset).max(0.000_000_1),
                notional_usd,
                latency_ms: request.execution_delay_ms + 4 + (index as u64 * 3) + latency_jitter_ms,
                depth_level: index as i32,
                fill_type: if hidden_liquidity_ratio >= 0.16 && index == 0 {
                    "hidden-liquidity".to_string()
                } else if partial_fill_risk >= 0.22 && index == slices.len() - 1 {
                    "partial-book".to_string()
                } else if matching_rule == "price-time-auction" && index == slices.len() - 1 {
                    "auction-cross".to_string()
                } else {
                    "book".to_string()
                },
                matching_rule: matching_rule.clone(),
                queue_priority_risk,
                hidden_liquidity_used_usd: (notional_usd * hidden_liquidity_ratio * if index == 0 { 0.3 } else { 0.08 }).max(0.0),
                slippage_bps: realized_slippage_bps,
                impact_bps: (realized_slippage_bps * (0.45 + partial_fill_risk * 0.35)).max(0.0),
            }
        })
        .collect()
}

fn estimate_slippage_bps(request: &ExecutionRequest, chosen: Option<&RouteCandidate>) -> f64 {
    let spread_bps = chosen.map(|candidate| candidate.spread_bps).unwrap_or(request.max_spread_bps.max(1.0));
    let depth = chosen.map(|candidate| candidate.available_depth_usd).unwrap_or(0.0);
    let depth_penalty = if depth > 0.0 {
        (request.estimated_notional_usd.max(0.0) / depth) * spread_bps * 0.75
    } else {
        spread_bps
    };
    let latency_penalty = chosen.map(|candidate| candidate.latency_ms).unwrap_or(0.0) * 0.01;
    (spread_bps * 0.42 + depth_penalty + latency_penalty).clamp(0.05, spread_bps.max(0.25) * 2.5)
}

fn estimate_fill_quality(request: &ExecutionRequest, chosen: Option<&RouteCandidate>, expected_slippage_bps: f64) -> f64 {
    let fill_probability = chosen.map(|candidate| candidate.fill_probability).unwrap_or(0.65);
    let spread_bps = chosen.map(|candidate| candidate.spread_bps).unwrap_or(request.max_spread_bps.max(1.0));
    let score = 100.0 - expected_slippage_bps * 6.5 - spread_bps * 1.2 + fill_probability * 18.0;
    score.clamp(1.0, 99.5)
}

fn build_arb_plan(
    request: &ExecutionRequest,
    candidates: &[RouteCandidate],
    market_snapshot: Option<&MarketSnapshot>,
    max_spread_bps: f64,
) -> Option<ArbPlan> {
    if candidates.len() < 2 {
        return None;
    }
    let best_bid_candidate = candidates
        .iter()
        .filter(|candidate| candidate.best_bid > 0.0)
        .max_by(|left, right| left.best_bid.total_cmp(&right.best_bid))?;
    let best_ask_candidate = candidates
        .iter()
        .filter(|candidate| candidate.best_ask > 0.0)
        .min_by(|left, right| left.best_ask.total_cmp(&right.best_ask))?;

    if best_bid_candidate.venue == best_ask_candidate.venue {
        return None;
    }

    let mid = ((best_bid_candidate.best_bid + best_ask_candidate.best_ask) / 2.0).max(0.000_000_1);
    let gross_edge_bps = ((best_bid_candidate.best_bid - best_ask_candidate.best_ask) / mid) * 10_000.0;
    let net_edge_bps = gross_edge_bps - max_spread_bps.max(0.0) * 0.65;
    let deviation_bps = market_snapshot.map(|snapshot| snapshot.deviation_bps).unwrap_or(0.0);
    let min_depth = best_bid_candidate
        .available_depth_usd
        .min(best_ask_candidate.available_depth_usd);
    let min_fill_probability = best_bid_candidate
        .fill_probability
        .min(best_ask_candidate.fill_probability);
    let executable = net_edge_bps > 1.0
        && min_depth >= (request.estimated_notional_usd.max(0.0) * 1.35)
        && min_fill_probability >= 0.6
        && deviation_bps <= 35.0;

    Some(ArbPlan {
        executable,
        buy_venue: best_ask_candidate.venue.clone(),
        sell_venue: best_bid_candidate.venue.clone(),
        gross_edge_bps,
        net_edge_bps,
        reason: if executable {
            "crossed_books_positive_after_strict_checks".to_string()
        } else if deviation_bps > 35.0 {
            "crossed_books_divergence_too_wide".to_string()
        } else if min_fill_probability < 0.6 {
            "crossed_books_fill_probability_too_low".to_string()
        } else if min_depth < (request.estimated_notional_usd.max(0.0) * 1.35) {
            "crossed_books_depth_too_thin".to_string()
        } else {
            "crossed_books_not_profitable".to_string()
        },
    })
}

fn build_market_snapshot(candidates: &[RouteCandidate]) -> Option<MarketSnapshot> {
    if candidates.is_empty() {
        return None;
    }
    let best_bid_candidate = candidates
        .iter()
        .filter(|candidate| candidate.best_bid > 0.0)
        .max_by(|left, right| left.best_bid.total_cmp(&right.best_bid));
    let best_ask_candidate = candidates
        .iter()
        .filter(|candidate| candidate.best_ask > 0.0)
        .min_by(|left, right| left.best_ask.total_cmp(&right.best_ask));
    let best_bid = best_bid_candidate.map(|candidate| candidate.best_bid).unwrap_or(0.0);
    let best_ask = best_ask_candidate.map(|candidate| candidate.best_ask).unwrap_or(0.0);
    let mid = if best_bid > 0.0 && best_ask > 0.0 {
        ((best_bid + best_ask) / 2.0).max(0.000_000_1)
    } else {
        candidates
            .iter()
            .map(midpoint)
            .find(|value| *value > 0.0)
            .unwrap_or(1.0)
    };
    let low_mid = candidates
        .iter()
        .map(midpoint)
        .filter(|value| *value > 0.0)
        .min_by(|left, right| left.total_cmp(right))
        .unwrap_or(mid);
    let high_mid = candidates
        .iter()
        .map(midpoint)
        .filter(|value| *value > 0.0)
        .max_by(|left, right| left.total_cmp(right))
        .unwrap_or(mid);
    Some(MarketSnapshot {
        candidate_count: candidates.len(),
        deviation_bps: ((high_mid - low_mid) / mid) * 10_000.0,
        total_depth_usd: candidates.iter().map(|candidate| candidate.available_depth_usd).sum(),
        best_bid,
        best_ask,
        buy_venue: best_ask_candidate.map(|candidate| candidate.venue.clone()).unwrap_or_default(),
        sell_venue: best_bid_candidate.map(|candidate| candidate.venue.clone()).unwrap_or_default(),
    })
}

fn midpoint(candidate: &RouteCandidate) -> f64 {
    if candidate.best_bid > 0.0 && candidate.best_ask > 0.0 {
        (candidate.best_bid + candidate.best_ask) / 2.0
    } else {
        candidate.last.max(1.0)
    }
}