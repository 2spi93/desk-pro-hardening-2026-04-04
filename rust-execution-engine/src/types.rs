use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRequest {
    pub decision_id: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub execution_delay_ms: u64,
    pub symbol: String,
    #[serde(default = "default_side")]
    pub side: String,
    #[serde(default)]
    pub estimated_notional_usd: f64,
    #[serde(default)]
    pub max_spread_bps: f64,
    #[serde(default)]
    pub preferred_venue: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub route_hint: Option<RouteHintPayload>,
    #[serde(default)]
    pub market_snapshot: Option<MarketSnapshot>,
    #[serde(default)]
    pub risk_gate: Option<Value>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RouteHintPayload {
    #[serde(default)]
    pub best: Option<RouteCandidate>,
    #[serde(default)]
    pub backup: Option<RouteCandidate>,
    #[serde(default)]
    pub candidates: Vec<RouteCandidate>,
    #[serde(default)]
    pub arbitrage: Option<ArbitrageHint>,
    #[serde(default)]
    pub deviation_bps: Option<f64>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RouteCandidate {
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub instrument: String,
    #[serde(default)]
    pub spread_bps: f64,
    #[serde(default)]
    pub available_depth_usd: f64,
    #[serde(default)]
    pub latency_ms: f64,
    #[serde(default)]
    pub fill_probability: f64,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub best_bid: f64,
    #[serde(default)]
    pub best_ask: f64,
    #[serde(default)]
    pub last: f64,
    #[serde(default)]
    pub matching_rule: String,
    #[serde(default)]
    pub queue_priority_risk: f64,
    #[serde(default)]
    pub hidden_liquidity_ratio: f64,
    #[serde(default)]
    pub partial_fill_risk: f64,
    #[serde(default)]
    pub micro_latency_jitter_ms: f64,
    #[serde(default)]
    pub freshness_ms: f64,
    #[serde(default)]
    pub infra_health: f64,
    #[serde(default)]
    pub network_regime: String,
    #[serde(default)]
    pub infra_factor: f64,
    #[serde(default)]
    pub reality_gap_profile_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ArbitrageHint {
    #[serde(default)]
    pub opportunity: bool,
    #[serde(default)]
    pub spread: f64,
    #[serde(default)]
    pub net_spread: f64,
    #[serde(default)]
    pub buy: String,
    #[serde(default)]
    pub sell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResponse {
    pub decision_id: String,
    pub engine: String,
    pub preview_only: bool,
    pub accepted: bool,
    pub status: String,
    pub route: RouteSelection,
    pub route_candidates: Vec<RouteCandidate>,
    pub market_snapshot: Option<MarketSnapshot>,
    pub fills: Vec<FillEvent>,
    pub expected_slippage_bps: f64,
    pub fill_quality_score: f64,
    pub hedge_guard: HedgeGuard,
    pub arb_plan: Option<ArbPlan>,
    pub processing_latency_ms: u64,
    #[serde(default)]
    pub reality_gap_sample: Option<RealityGapSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteSelection {
    pub chosen: Option<RouteCandidate>,
    pub backup: Option<RouteCandidate>,
    pub mode: String,
    pub source: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FillEvent {
    pub fill_id: String,
    pub venue: String,
    pub price: f64,
    pub notional_usd: f64,
    pub latency_ms: u64,
    #[serde(default)]
    pub depth_level: i32,
    #[serde(default)]
    pub fill_type: String,
    #[serde(default)]
    pub matching_rule: String,
    #[serde(default)]
    pub queue_priority_risk: f64,
    #[serde(default)]
    pub hidden_liquidity_used_usd: f64,
    #[serde(default)]
    pub slippage_bps: f64,
    #[serde(default)]
    pub impact_bps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RealityGapExecutionSnapshot {
    #[serde(default)]
    pub slippage_bps: Option<f64>,
    #[serde(default)]
    pub fill_probability: Option<f64>,
    #[serde(default)]
    pub fill_ratio: Option<f64>,
    #[serde(default)]
    pub latency_ms: Option<f64>,
    #[serde(default)]
    pub impact_bps: Option<f64>,
    #[serde(default)]
    pub queue_ahead_qty: Option<f64>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RealityGapSample {
    #[serde(default)]
    pub sample_id: String,
    #[serde(default)]
    pub decision_id: String,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub regime: String,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub predicted: RealityGapExecutionSnapshot,
    #[serde(default)]
    pub realized: RealityGapExecutionSnapshot,
    #[serde(default)]
    pub failure_source: Option<String>,
    #[serde(default)]
    pub failure_reasons: Vec<String>,
    #[serde(default)]
    pub calibration_action: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RealityGapCalibrationProfile {
    #[serde(default)]
    pub profile_key: String,
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub regime: String,
    #[serde(default)]
    pub sample_count: i64,
    #[serde(default)]
    pub avg_gap_slippage_bps: f64,
    #[serde(default)]
    pub avg_gap_fill_probability: f64,
    #[serde(default)]
    pub avg_gap_latency_ms: f64,
    #[serde(default)]
    pub avg_gap_impact_bps: f64,
    #[serde(default)]
    pub avg_gap_queue_ahead_qty: f64,
    #[serde(default)]
    pub adjustment_factors: Value,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HedgeGuard {
    pub allow_execution: bool,
    pub reason_codes: Vec<String>,
    pub required_depth_usd: f64,
    pub available_depth_usd: f64,
    pub observed_spread_bps: f64,
    pub max_spread_bps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArbPlan {
    pub executable: bool,
    pub buy_venue: String,
    pub sell_venue: String,
    pub gross_edge_bps: f64,
    pub net_edge_bps: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MarketSnapshot {
    #[serde(default)]
    pub candidate_count: usize,
    #[serde(default)]
    pub deviation_bps: f64,
    #[serde(default)]
    pub total_depth_usd: f64,
    #[serde(default)]
    pub best_bid: f64,
    #[serde(default)]
    pub best_ask: f64,
    #[serde(default)]
    pub buy_venue: String,
    #[serde(default)]
    pub sell_venue: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub engine: String,
    pub port: u16,
    pub hft_enabled: bool,
    pub hft_worker_started: bool,
    pub hft_queue_depth: usize,
    pub hft_ring_capacity: usize,
    pub hft_processed: u64,
    pub hft_dropped: u64,
}

fn default_side() -> String {
    "buy".to_string()
}