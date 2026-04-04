from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SystemMode(str, Enum):
    OBSERVE = "observe"
    SUGGEST = "suggest"
    GUARDED_AUTO = "guarded_auto"
    MANAGED_LIVE = "managed_live"


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class TradeIntent(BaseModel):
    intent_id: str = Field(default_factory=lambda: str(uuid4()))
    strategy_id: str
    portfolio_id: str
    venue: str
    instrument: str
    side: Side
    reason_code: str
    confidence: float = Field(ge=0.0, le=1.0)
    target_notional_usd: float = Field(gt=0)
    max_slippage_bps: int = Field(gt=0)
    leverage: float = Field(default=1.0, gt=0)
    risk_tags: list[str] = Field(default_factory=list)
    explainability: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=utc_now_iso)


class RiskCheckRequest(BaseModel):
    intent: TradeIntent
    system_mode: SystemMode


class RiskDecision(BaseModel):
    decision: str
    reasons: list[str] = Field(default_factory=list)
    policy_version: str
    approved_notional_usd: float = 0.0
    risk_snapshot: dict[str, Any] = Field(default_factory=dict)


class ExecutionRequest(BaseModel):
    intent: TradeIntent
    risk_decision: RiskDecision
    execution_mode: str = "paper"
    execution_delay_ms: int = Field(default=0, ge=0, le=5000)


class OrderResult(BaseModel):
    order_id: str
    status: str
    venue: str
    instrument: str
    side: Side
    requested_notional_usd: float
    filled_notional_usd: float
    avg_fill_price: float
    execution_mode: str
    timestamp: str = Field(default_factory=utc_now_iso)


class RealityGapExecutionSnapshot(BaseModel):
    slippage_bps: float | None = None
    fill_probability: float | None = Field(default=None, ge=0.0, le=1.0)
    fill_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    latency_ms: float | None = None
    impact_bps: float | None = None
    queue_ahead_qty: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RealityGapSample(BaseModel):
    sample_id: str = Field(default_factory=lambda: str(uuid4()))
    decision_id: str
    symbol: str
    venue: str
    regime: str = "UNKNOWN"
    side: str = "hold"
    predicted: RealityGapExecutionSnapshot
    realized: RealityGapExecutionSnapshot
    failure_source: str | None = None
    failure_reasons: list[str] = Field(default_factory=list)
    calibration_action: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=utc_now_iso)


class RealityGapIngestRequest(BaseModel):
    sample: RealityGapSample
    apply_calibration: bool = True
    train_brain: bool = True


class RealityGapCalibrationProfile(BaseModel):
    profile_key: str
    venue: str
    symbol: str
    regime: str
    sample_count: int = 0
    avg_gap_slippage_bps: float = 0.0
    avg_gap_fill_probability: float = 0.0
    avg_gap_latency_ms: float = 0.0
    avg_gap_impact_bps: float = 0.0
    avg_gap_queue_ahead_qty: float = 0.0
    adjustment_factors: dict[str, float] = Field(default_factory=dict)
    updated_at: str = Field(default_factory=utc_now_iso)


class IntentSubmissionRequest(BaseModel):
    intent: TradeIntent
    auto_execute: bool = True


class IntentSubmissionResponse(BaseModel):
    intent_id: str
    system_mode: SystemMode
    status: str
    risk_decision: RiskDecision
    order: OrderResult | None = None


class SystemModeChangeRequest(BaseModel):
    mode: SystemMode


class ApprovalRequest(BaseModel):
    signed_payload: str
    signature: str


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: int
    role: str
    username: str
    password_must_change: bool = False


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=12)


class StrategyCreateRequest(BaseModel):
    strategy_id: str
    name: str
    market: str
    setup_type: str
    notes: str = ""


class StrategyPromotionRequest(BaseModel):
    to_level: int = Field(ge=0, le=6)
    rationale: str = ""
    metrics: dict[str, Any] = Field(default_factory=dict)


class AuditEvent(BaseModel):
    category: str
    timestamp: str = Field(default_factory=utc_now_iso)
    payload: dict[str, Any]


class ClientCreateRequest(BaseModel):
    client_id: str
    legal_name: str
    client_type: str
    base_currency: str = "USD"
    status: str = "active"
    kyc_status: str = "not_required"
    metadata: dict[str, Any] = Field(default_factory=dict)


class ClientEntity(BaseModel):
    client_id: str
    legal_name: str
    client_type: str
    base_currency: str = "USD"
    status: str
    kyc_status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None


class UserClientMembershipCreateRequest(BaseModel):
    user_id: int
    membership_role: str
    is_primary: bool = False
    permissions: list[str] = Field(default_factory=list)


class UserClientMembership(BaseModel):
    user_id: int
    client_id: str
    membership_role: str
    is_primary: bool = False
    permissions: list[str] = Field(default_factory=list)
    created_at: str | None = None


class AccountCreateRequest(BaseModel):
    account_id: str
    client_id: str
    account_type: str
    venue: str
    connector_type: str
    mode: str
    base_currency: str = "USD"
    status: str = "active"
    external_ref: str | None = None
    display_name: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CanonicalAccount(BaseModel):
    account_id: str
    client_id: str
    account_type: str
    venue: str
    connector_type: str
    mode: str
    base_currency: str = "USD"
    status: str
    external_ref: str | None = None
    display_name: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None


class AccountBalanceSnapshot(BaseModel):
    account_id: str
    asset_symbol: str
    available_qty: float = 0.0
    locked_qty: float = 0.0
    equity_usd: float = 0.0
    mark_price_usd: float | None = None
    as_of: str
    source: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ConsolidatedPosition(BaseModel):
    position_id: str
    account_id: str
    portfolio_id: str | None = None
    strategy_id: str | None = None
    symbol: str
    instrument: str
    side: str
    quantity: float
    notional_usd: float
    avg_entry_price: float
    mark_price: float
    pnl_unrealized_usd: float = 0.0
    pnl_realized_usd: float = 0.0
    as_of: str
    source: str
    payload: dict[str, Any] = Field(default_factory=dict)


class PortfolioCreateRequest(BaseModel):
    portfolio_id: str
    client_id: str
    name: str
    base_currency: str = "USD"
    mandate_type: str
    risk_profile: str = "balanced"
    benchmark_symbol: str | None = None
    status: str = "active"
    metadata: dict[str, Any] = Field(default_factory=dict)


class PortfolioRecord(BaseModel):
    portfolio_id: str
    client_id: str
    name: str
    base_currency: str = "USD"
    mandate_type: str
    risk_profile: str
    benchmark_symbol: str | None = None
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None


class PortfolioAccountAttachRequest(BaseModel):
    account_id: str
    allocation_weight: float = Field(default=1.0, gt=0)
    allocation_cap_usd: float | None = Field(default=None, gt=0)
    status: str = "active"


class PortfolioAccountLink(BaseModel):
    portfolio_id: str
    account_id: str
    allocation_weight: float = 1.0
    allocation_cap_usd: float | None = None
    status: str = "active"


class StrategyRegistryRecord(BaseModel):
    strategy_id: str
    portfolio_id: str
    owner_user_id: int | None = None
    strategy_type: str
    status: str
    capital_allocation_mode: str = "shared"
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None


class PortfolioStatePosition(BaseModel):
    account_id: str
    portfolio_id: str | None = None
    strategy_id: str | None = None
    symbol: str
    instrument: str
    side: str
    quantity: float
    notional_usd: float
    avg_entry_price: float
    mark_price: float
    pnl_unrealized_usd: float = 0.0
    pnl_realized_usd: float = 0.0
    as_of: str
    source: str


class PortfolioStateSnapshot(BaseModel):
    portfolio_id: str
    client_id: str
    as_of: str
    equity_usd: float = 0.0
    gross_exposure_usd: float = 0.0
    net_exposure_usd: float = 0.0
    gross_exposure_pct: float = 0.0
    net_exposure_pct: float = 0.0
    total_notional_usd: float = 0.0
    current_pnl_usd: float = 0.0
    daily_pnl_usd: float = 0.0
    max_drawdown_pct: float = 0.0
    var_95_pct: float = 0.0
    sharpe_ratio: float | None = None
    correlation_matrix: dict[str, Any] = Field(default_factory=dict)
    balances: list[AccountBalanceSnapshot] = Field(default_factory=list)
    positions: list[PortfolioStatePosition] = Field(default_factory=list)


class PortfolioRiskSnapshot(BaseModel):
    portfolio_id: str
    client_id: str
    as_of: str
    equity_usd: float = 0.0
    gross_exposure_usd: float = 0.0
    net_exposure_usd: float = 0.0
    long_exposure_usd: float = 0.0
    short_exposure_usd: float = 0.0
    gross_exposure_pct: float = 0.0
    net_exposure_pct: float = 0.0
    leverage_gross: float = 0.0
    leverage_net: float = 0.0
    drawdown_pct: float = 0.0
    var_95_usd: float = 0.0
    var_99_usd: float = 0.0
    concentration_pct: float = 0.0
    largest_symbol: str | None = None
    symbol_exposures: list[dict[str, Any]] = Field(default_factory=list)
    correlation_pairs: list[dict[str, Any]] = Field(default_factory=list)
    var_model: dict[str, Any] = Field(default_factory=dict)
    breaches: list[dict[str, Any]] = Field(default_factory=list)


class PerformanceSummary(BaseModel):
    scope_type: str
    scope_id: str
    period_start: str
    period_end: str
    trade_count: int = 0
    realized_pnl_usd: float = 0.0
    unrealized_pnl_usd: float = 0.0
    fees_usd: float = 0.0
    win_rate_pct: float = 0.0
    expectancy_usd: float = 0.0
    avg_slippage_bps: float = 0.0
    avg_latency_ms: float = 0.0
    sharpe_ratio: float | None = None


class PerformanceTimeSeriesPoint(BaseModel):
    bucket_start: str
    bucket_granularity: str
    pnl_realized_usd: float = 0.0
    pnl_unrealized_usd: float = 0.0
    fees_usd: float = 0.0
    trade_count: int = 0
    win_rate_pct: float = 0.0


class PerformanceAttributionRow(BaseModel):
    scope_type: str
    scope_id: str
    period_start: str
    period_end: str
    strategy_id: str | None = None
    symbol: str | None = None
    venue: str | None = None
    realized_pnl_usd: float = 0.0
    unrealized_pnl_usd: float = 0.0
    fees_usd: float = 0.0
    trade_count: int = 0
    win_rate_pct: float = 0.0
    expectancy_usd: float = 0.0
    avg_slippage_bps: float = 0.0
    avg_latency_ms: float = 0.0
    avg_score_pre_trade: float = 0.0
    gross_profit_usd: float = 0.0
    gross_loss_usd: float = 0.0
    profit_factor: float | None = None
    pnl_contribution_pct: float = 0.0
    avg_mae: float = 0.0
    avg_mfe: float = 0.0
    group_by: list[str] = Field(default_factory=list)
    sharpe_ratio: float | None = None
