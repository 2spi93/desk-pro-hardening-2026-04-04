from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from typing import Any, Iterable

import psycopg
from psycopg.rows import dict_row


def _secret_env(name: str, default: str) -> str:
    file_path = os.getenv(f"{name}_FILE", "").strip()
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    value = os.getenv(name, "").strip()
    return value or default


DATABASE_URL = _secret_env("DATABASE_URL", "postgresql://txt:txt@127.0.0.1:5432/mission_control")


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS system_config (
  config_key TEXT PRIMARY KEY,
  config_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    password_must_change BOOLEAN NOT NULL DEFAULT TRUE,
    last_password_change_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_must_change BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_password_change_at TIMESTAMPTZ;

-- Idempotent: extend role CHECK constraint to include external client roles.
-- The original constraint was auto-named `users_role_check` by PostgreSQL.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'users_role_check'
      AND check_clause LIKE '%client%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('viewer', 'operator', 'admin', 'client', 'trader', 'investor', 'premium', 'pro'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent TEXT,
    ip_address TEXT
);

CREATE TABLE IF NOT EXISTS user_ui_preferences (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS self_learning_v4_states (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, account_id, symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS risk_policies (
  policy_version TEXT PRIMARY KEY,
  policy JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  instrument TEXT NOT NULL,
  side TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  target_notional_usd DOUBLE PRECISION NOT NULL,
  max_slippage_bps INTEGER NOT NULL,
  leverage DOUBLE PRECISION NOT NULL,
  risk_tags JSONB NOT NULL,
  explainability JSONB NOT NULL,
  system_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_decision JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  intent_id TEXT REFERENCES intents(intent_id) ON DELETE SET NULL,
  venue TEXT NOT NULL,
  instrument TEXT NOT NULL,
  side TEXT NOT NULL,
  requested_notional_usd DOUBLE PRECISION NOT NULL,
  filled_notional_usd DOUBLE PRECISION NOT NULL,
  avg_fill_price DOUBLE PRECISION NOT NULL,
  execution_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_chain_events (
    id BIGSERIAL PRIMARY KEY,
    prev_hash TEXT,
    event_hash TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_events (
  id BIGSERIAL PRIMARY KEY,
  intent_id TEXT NOT NULL,
  approver TEXT NOT NULL,
  role TEXT NOT NULL,
  signature TEXT NOT NULL,
  signed_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  instrument TEXT NOT NULL,
  bid DOUBLE PRECISION NOT NULL,
  ask DOUBLE PRECISION NOT NULL,
  last DOUBLE PRECISION NOT NULL,
  spread_bps DOUBLE PRECISION NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_ohlcv (
    id BIGSERIAL PRIMARY KEY,
    venue TEXT NOT NULL,
    instrument TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    open DOUBLE PRECISION NOT NULL,
    high DOUBLE PRECISION NOT NULL,
    low DOUBLE PRECISION NOT NULL,
    close DOUBLE PRECISION NOT NULL,
    volume DOUBLE PRECISION NOT NULL,
    quote_volume DOUBLE PRECISION,
    trades_count INTEGER,
    source TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (venue, instrument, timeframe, bucket_start)
);

CREATE TABLE IF NOT EXISTS market_trades (
    id BIGSERIAL PRIMARY KEY,
    venue TEXT NOT NULL,
    instrument TEXT NOT NULL,
    trade_id TEXT,
    side TEXT,
    price DOUBLE PRECISION NOT NULL,
    size DOUBLE PRECISION NOT NULL,
    traded_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_orderbook_snapshots (
    id BIGSERIAL PRIMARY KEY,
    venue TEXT NOT NULL,
    instrument TEXT NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL,
    best_bid DOUBLE PRECISION,
    best_ask DOUBLE PRECISION,
    spread_bps DOUBLE PRECISION,
    depth_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_derivatives_metrics (
    id BIGSERIAL PRIMARY KEY,
    venue TEXT NOT NULL,
    instrument TEXT NOT NULL,
    funding_rate DOUBLE PRECISION,
    open_interest DOUBLE PRECISION,
    mark_price DOUBLE PRECISION,
    next_funding_time TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_telemetry (
    telemetry_id TEXT PRIMARY KEY,
    decision_id TEXT,
    account_id TEXT,
    symbol TEXT,
    side TEXT,
    lots DOUBLE PRECISION,
    route_chosen TEXT,
    route_backup TEXT,
    route_reason TEXT,
    route_score DOUBLE PRECISION,
    backup_score DOUBLE PRECISION,
    quote_spread_bps DOUBLE PRECISION,
    available_depth_usd DOUBLE PRECISION,
    expected_slippage_bps DOUBLE PRECISION,
    realized_slippage_bps DOUBLE PRECISION,
    latency_e2e_ms INTEGER,
    ts_decision TIMESTAMPTZ,
    ts_intent TIMESTAMPTZ,
    ts_routing TIMESTAMPTZ,
    ts_broker_accept TIMESTAMPTZ,
    ts_fill_partial TIMESTAMPTZ,
    ts_fill_final TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_fill_events (
    id BIGSERIAL PRIMARY KEY,
    decision_id TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    venue TEXT NOT NULL,
    instrument TEXT NOT NULL,
    side TEXT NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    size_base DOUBLE PRECISION NOT NULL,
    notional_usd DOUBLE PRECISION NOT NULL,
    depth_level INTEGER,
    fill_type TEXT NOT NULL DEFAULT 'book',
    slippage_bps DOUBLE PRECISION,
    fill_latency_ms INTEGER,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    filled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (decision_id, fill_id)
);

CREATE TABLE IF NOT EXISTS reality_gap_samples (
    sample_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    venue TEXT NOT NULL,
    regime TEXT NOT NULL DEFAULT 'UNKNOWN',
    side TEXT NOT NULL DEFAULT 'hold',
    failure_source TEXT,
    failure_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    calibration_action TEXT,
    gap_slippage_bps DOUBLE PRECISION,
    gap_fill_probability DOUBLE PRECISION,
    gap_latency_ms DOUBLE PRECISION,
    gap_impact_bps DOUBLE PRECISION,
    gap_queue_ahead_qty DOUBLE PRECISION,
    predicted_execution JSONB NOT NULL DEFAULT '{}'::jsonb,
    realized_execution JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reality_gap_calibration_profiles (
    profile_key TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    regime TEXT NOT NULL DEFAULT 'UNKNOWN',
    sample_count INTEGER NOT NULL DEFAULT 0,
    calibration JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategies (
    strategy_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    market TEXT NOT NULL,
    setup_type TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    current_level INTEGER NOT NULL DEFAULT 0 CHECK (current_level BETWEEN 0 AND 6),
    status TEXT NOT NULL DEFAULT 'active',
    latest_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_promotions (
    id BIGSERIAL PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(strategy_id) ON DELETE CASCADE,
    from_level INTEGER NOT NULL,
    to_level INTEGER NOT NULL,
    approved_by TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_orchestration_events (
    id BIGSERIAL PRIMARY KEY,
    task TEXT NOT NULL,
    prompt_preview TEXT NOT NULL,
    criticality TEXT NOT NULL,
    route JSONB NOT NULL,
    provider_used TEXT NOT NULL,
    model_used TEXT NOT NULL,
    estimated_cost_usd DOUBLE PRECISION NOT NULL,
    retries_used INTEGER NOT NULL DEFAULT 0,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kairos_shadow_cycles (
    cycle_id TEXT PRIMARY KEY,
    cycle_at TIMESTAMPTZ NOT NULL,
    symbol TEXT NOT NULL,
    venue TEXT NOT NULL,
    shadow_action TEXT NOT NULL,
    shadow_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    decision_id TEXT NOT NULL,
    decision_direction TEXT NOT NULL DEFAULT 'wait',
    predictor_should_execute BOOLEAN NOT NULL DEFAULT FALSE,
    memory_source TEXT NOT NULL DEFAULT 'none',
    memory_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    memory_recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
    proposed_trade JSONB,
    cycle_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kairos_shadow_decisions (
    decision_id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL REFERENCES kairos_shadow_cycles(cycle_id) ON DELETE CASCADE,
    decision_at TIMESTAMPTZ NOT NULL,
    symbol TEXT NOT NULL,
    venue TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'wait',
    meta_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    agent_consensus_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    risk_approved BOOLEAN NOT NULL DEFAULT FALSE,
    risk_reason TEXT NOT NULL DEFAULT '',
    predictor_should_execute BOOLEAN NOT NULL DEFAULT FALSE,
    memory_source TEXT NOT NULL DEFAULT 'none',
    memory_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    recommended_execution JSONB,
    decision_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mt5_accounts (
    account_id TEXT PRIMARY KEY,
    broker TEXT NOT NULL,
    server TEXT NOT NULL,
    login TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
    status TEXT NOT NULL DEFAULT 'disconnected',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mt5_order_events (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES mt5_accounts(account_id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    lots DOUBLE PRECISION NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_gate JSONB NOT NULL,
    broker_ticket TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mt5_order_events ADD COLUMN IF NOT EXISTS chosen_route TEXT;
ALTER TABLE mt5_order_events ADD COLUMN IF NOT EXISTS expected_slippage_bps DOUBLE PRECISION;
ALTER TABLE mt5_order_events ADD COLUMN IF NOT EXISTS execution_context JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS mt5_live_approvals (
    approval_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES mt5_accounts(account_id) ON DELETE CASCADE,
    order_payload JSONB NOT NULL,
    first_approved_by TEXT NOT NULL,
    second_approved_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'rejected', 'cancelled')),
    execution_result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS kill_switch_events (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decision_outcomes (
    decision_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    strategy_id TEXT,
    symbol TEXT,
    provider TEXT,
    regime TEXT,
    score_pre_trade DOUBLE PRECISION,
    pnl_5m DOUBLE PRECISION,
    pnl_1h DOUBLE PRECISION,
    pnl_24h DOUBLE PRECISION,
    mae DOUBLE PRECISION,
    mfe DOUBLE PRECISION,
    slippage_real_bps DOUBLE PRECISION,
    latency_ms INTEGER,
    fees_usd DOUBLE PRECISION,
    net_result_usd DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_embeddings (
    embedding_id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT,
    symbol TEXT,
    regime TEXT,
    timeframe TEXT,
    case_timestamp TIMESTAMPTZ,
    decision_action TEXT,
    outcome_label TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    model_name TEXT NOT NULL,
    vector JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS symbol TEXT;
ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS regime TEXT;
ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS timeframe TEXT;
ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS case_timestamp TIMESTAMPTZ;
ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS decision_action TEXT;
ALTER TABLE strategy_embeddings ADD COLUMN IF NOT EXISTS outcome_label TEXT;

CREATE TABLE IF NOT EXISTS retrieval_events (
    id BIGSERIAL PRIMARY KEY,
    query_hash TEXT NOT NULL,
    strategy_id TEXT,
    symbol TEXT,
    regime TEXT,
    timeframe TEXT,
    requested_top_k INTEGER NOT NULL,
    candidates_count INTEGER NOT NULL,
    results_count INTEGER NOT NULL,
    avg_vector_similarity DOUBLE PRECISION,
    avg_final_similarity DOUBLE PRECISION,
    win_rate_top_results DOUBLE PRECISION,
    memory_impact_score_delta DOUBLE PRECISION,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_regime_thresholds (
    regime TEXT PRIMARY KEY,
    min_samples INTEGER NOT NULL DEFAULT 20,
    min_win_rate DOUBLE PRECISION NOT NULL DEFAULT 0.48,
    max_drawdown_usd DOUBLE PRECISION NOT NULL DEFAULT 800.0,
    max_avg_loss_usd DOUBLE PRECISION NOT NULL DEFAULT 120.0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_health_state (
    strategy_id TEXT NOT NULL,
    regime TEXT NOT NULL,
    window_hours INTEGER NOT NULL DEFAULT 168,
    sample_count INTEGER NOT NULL DEFAULT 0,
    win_rate DOUBLE PRECISION,
    avg_net_result_usd DOUBLE PRECISION,
    drawdown_usd DOUBLE PRECISION,
    drift_detected BOOLEAN NOT NULL DEFAULT FALSE,
    auto_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    auto_resumed BOOLEAN NOT NULL DEFAULT FALSE,
    cooldown_until TIMESTAMPTZ,
    reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (strategy_id, regime, window_hours)
);

ALTER TABLE strategy_health_state ADD COLUMN IF NOT EXISTS auto_resumed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE strategy_health_state ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS memory_ab_events (
    id BIGSERIAL PRIMARY KEY,
    decision_id TEXT,
    source TEXT NOT NULL,
    strategy_id TEXT,
    symbol TEXT,
    regime TEXT,
    arm TEXT NOT NULL CHECK (arm IN ('memory_on', 'memory_off')),
    score_before DOUBLE PRECISION,
    score_after DOUBLE PRECISION,
    action TEXT,
    outcome_net_result_usd DOUBLE PRECISION,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incident_tickets (
    id BIGSERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    assignee TEXT,
    source TEXT NOT NULL DEFAULT 'ops-chatbot',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT,
    resolution_note TEXT,
    closed_by TEXT,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE incident_tickets ADD COLUMN IF NOT EXISTS assignee TEXT;
ALTER TABLE incident_tickets ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE incident_tickets ADD COLUMN IF NOT EXISTS closed_by TEXT;
ALTER TABLE incident_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS chatbot_action_confirmations (
    id BIGSERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    action_type TEXT NOT NULL,
    action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    legal_name TEXT NOT NULL,
    client_type TEXT NOT NULL CHECK (client_type IN ('internal', 'individual', 'prop', 'fund', 'family_office')),
    base_currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'suspended', 'closed')),
    kyc_status TEXT NOT NULL DEFAULT 'not_required',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_client_memberships (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    membership_role TEXT NOT NULL CHECK (membership_role IN ('admin', 'trader', 'investor', 'viewer', 'operator')),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, client_id, membership_role)
);

CREATE TABLE IF NOT EXISTS accounts_registry (
    account_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    account_type TEXT NOT NULL CHECK (account_type IN ('broker', 'exchange', 'wallet', 'strategy_subaccount', 'omnibus')),
    venue TEXT NOT NULL,
    connector_type TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
    base_currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'disabled', 'error', 'closed')),
    external_ref TEXT,
    display_name TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_balances (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts_registry(account_id) ON DELETE CASCADE,
    asset_symbol TEXT NOT NULL,
    available_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
    locked_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
    equity_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    mark_price_usd DOUBLE PRECISION,
    as_of TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (account_id, asset_symbol, as_of)
);

CREATE TABLE IF NOT EXISTS consolidated_positions (
    position_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts_registry(account_id) ON DELETE CASCADE,
    portfolio_id TEXT,
    strategy_id TEXT,
    symbol TEXT NOT NULL,
    instrument TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('long', 'short', 'flat')),
    quantity DOUBLE PRECISION NOT NULL,
    notional_usd DOUBLE PRECISION NOT NULL,
    avg_entry_price DOUBLE PRECISION NOT NULL,
    mark_price DOUBLE PRECISION NOT NULL,
    pnl_unrealized_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    pnl_realized_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    as_of TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS portfolios (
    portfolio_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    base_currency TEXT NOT NULL DEFAULT 'USD',
    mandate_type TEXT NOT NULL CHECK (mandate_type IN ('discretionary', 'advisory', 'simulation', 'treasury')),
    risk_profile TEXT NOT NULL DEFAULT 'balanced',
    benchmark_symbol TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portfolio_accounts (
    id BIGSERIAL PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts_registry(account_id) ON DELETE CASCADE,
    allocation_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    allocation_cap_usd DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE (portfolio_id, account_id)
);

CREATE TABLE IF NOT EXISTS strategies_registry (
    strategy_id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    strategy_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'paper', 'active', 'paused', 'retired')),
    capital_allocation_mode TEXT NOT NULL DEFAULT 'shared',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
    gross_exposure_usd DOUBLE PRECISION NOT NULL,
    net_exposure_usd DOUBLE PRECISION NOT NULL,
    long_exposure_usd DOUBLE PRECISION NOT NULL,
    short_exposure_usd DOUBLE PRECISION NOT NULL,
    equity_usd DOUBLE PRECISION NOT NULL,
    pnl_day_usd DOUBLE PRECISION NOT NULL,
    drawdown_pct DOUBLE PRECISION NOT NULL,
    var_95_usd DOUBLE PRECISION,
    var_99_usd DOUBLE PRECISION,
    leverage_gross DOUBLE PRECISION,
    leverage_net DOUBLE PRECISION,
    as_of TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS portfolio_symbol_exposure (
    id BIGSERIAL PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES portfolio_snapshots(snapshot_id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    net_notional_usd DOUBLE PRECISION NOT NULL,
    gross_notional_usd DOUBLE PRECISION NOT NULL,
    beta_weighted_notional_usd DOUBLE PRECISION,
    concentration_pct DOUBLE PRECISION NOT NULL,
    UNIQUE (snapshot_id, symbol)
);

CREATE TABLE IF NOT EXISTS portfolio_correlation_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES portfolio_snapshots(snapshot_id) ON DELETE CASCADE,
    symbol_x TEXT NOT NULL,
    symbol_y TEXT NOT NULL,
    correlation_30d DOUBLE PRECISION NOT NULL,
    UNIQUE (snapshot_id, symbol_x, symbol_y)
);

CREATE TABLE IF NOT EXISTS risk_limit_breaches (
    breach_id TEXT PRIMARY KEY,
    portfolio_id TEXT REFERENCES portfolios(portfolio_id) ON DELETE SET NULL,
    account_id TEXT REFERENCES accounts_registry(account_id) ON DELETE SET NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('portfolio', 'account', 'strategy', 'client')),
    breach_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
    current_value DOUBLE PRECISION,
    limit_value DOUBLE PRECISION,
    action_taken TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS performance_timeseries (
    id BIGSERIAL PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('client', 'portfolio', 'account', 'strategy', 'symbol', 'provider')),
    scope_id TEXT NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    bucket_granularity TEXT NOT NULL CHECK (bucket_granularity IN ('1h', '1d', '1mo')),
    equity_open_usd DOUBLE PRECISION,
    equity_close_usd DOUBLE PRECISION,
    pnl_realized_usd DOUBLE PRECISION,
    pnl_unrealized_usd DOUBLE PRECISION,
    flow_net_usd DOUBLE PRECISION,
    drawdown_pct DOUBLE PRECISION,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scope_type, scope_id, bucket_granularity, bucket_start)
);

CREATE TABLE IF NOT EXISTS performance_attribution (
    id BIGSERIAL PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('client', 'portfolio', 'account', 'strategy')),
    scope_id TEXT NOT NULL,
    strategy_id TEXT,
    symbol TEXT,
    venue TEXT,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    realized_pnl_usd DOUBLE PRECISION NOT NULL,
    unrealized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    win_rate_pct DOUBLE PRECISION,
    expectancy_usd DOUBLE PRECISION,
    sharpe_ratio DOUBLE PRECISION,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capital_flow_events (
    event_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts_registry(account_id) ON DELETE CASCADE,
    portfolio_id TEXT REFERENCES portfolios(portfolio_id) ON DELETE SET NULL,
    venue TEXT NOT NULL,
    connector_type TEXT,
    pocket TEXT,
    event_type TEXT NOT NULL,
    flow_direction TEXT NOT NULL DEFAULT 'neutral',
    asset_symbol TEXT,
    amount_native DOUBLE PRECISION,
    amount_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    raw_cash_usd DOUBLE PRECISION,
    equivalent_usd DOUBLE PRECISION,
    counterparty TEXT,
    description TEXT,
    external_event_id TEXT,
    source TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, source, external_event_id)
);

CREATE TABLE IF NOT EXISTS investor_reports (
    report_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    portfolio_id TEXT REFERENCES portfolios(portfolio_id) ON DELETE SET NULL,
    report_month DATE NOT NULL,
    report_type TEXT NOT NULL CHECK (report_type IN ('monthly', 'quarterly', 'custom')),
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
    storage_path TEXT,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE OR REPLACE VIEW v_accounts_canonical AS
SELECT
    ar.account_id,
    ar.client_id,
    ar.account_type,
    ar.venue,
    ar.connector_type,
    ar.mode,
    ar.base_currency,
    ar.status,
    ar.external_ref,
    ar.display_name,
    ar.metadata,
    ar.created_at,
    ar.updated_at,
    mt5.broker AS connector_broker,
    mt5.server AS connector_server,
    mt5.login AS connector_login,
    mt5.status AS connector_status,
    mt5.metadata AS connector_metadata
FROM accounts_registry ar
LEFT JOIN mt5_accounts mt5 ON mt5.account_id = ar.account_id;

CREATE OR REPLACE VIEW v_positions_canonical AS
SELECT
    cp.position_id,
    cp.account_id,
    ar.client_id,
    cp.portfolio_id,
    cp.strategy_id,
    cp.symbol,
    cp.instrument,
    cp.side,
    cp.quantity,
    cp.notional_usd,
    cp.avg_entry_price,
    cp.mark_price,
    cp.pnl_unrealized_usd,
    cp.pnl_realized_usd,
    cp.as_of,
    cp.source,
    cp.payload
FROM consolidated_positions cp
JOIN accounts_registry ar ON ar.account_id = cp.account_id;

CREATE OR REPLACE VIEW v_execution_ledger AS
SELECT
    i.intent_id,
    i.strategy_id,
    i.portfolio_id,
    i.venue,
    i.instrument,
    i.side,
    i.reason_code,
    i.confidence,
    i.target_notional_usd,
    i.max_slippage_bps,
    i.system_mode,
    i.status AS intent_status,
    i.risk_decision,
    i.created_at AS intent_created_at,
    o.order_id,
    o.status AS order_status,
    o.execution_mode,
    o.requested_notional_usd,
    o.filled_notional_usd,
    o.avg_fill_price,
    o.created_at AS order_created_at,
    et.telemetry_id,
    et.account_id,
    et.route_chosen,
    et.route_reason,
    et.realized_slippage_bps,
    et.latency_e2e_ms,
    fill_summary.total_fills,
    fill_summary.total_fill_notional_usd,
    fill_summary.last_fill_at
FROM intents i
LEFT JOIN orders o ON o.intent_id = i.intent_id
LEFT JOIN execution_telemetry et ON et.decision_id = i.intent_id
LEFT JOIN (
    SELECT
        decision_id,
        COUNT(*) AS total_fills,
        COALESCE(SUM(notional_usd), 0) AS total_fill_notional_usd,
        MAX(filled_at) AS last_fill_at
    FROM execution_fill_events
    GROUP BY decision_id
) AS fill_summary ON fill_summary.decision_id = i.intent_id;

CREATE INDEX IF NOT EXISTS idx_ai_orchestration_events_created_at
ON ai_orchestration_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kairos_shadow_cycles_created_at
ON kairos_shadow_cycles (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kairos_shadow_cycles_symbol_venue
ON kairos_shadow_cycles (symbol, venue, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kairos_shadow_decisions_created_at
ON kairos_shadow_decisions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kairos_shadow_decisions_symbol_venue
ON kairos_shadow_decisions (symbol, venue, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clients_status
ON clients (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_client_memberships_user
ON user_client_memberships (user_id, is_primary DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_accounts_registry_client
ON accounts_registry (client_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_accounts_registry_connector
ON accounts_registry (connector_type, venue, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_balances_account_asset
ON account_balances (account_id, asset_symbol, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_consolidated_positions_account_symbol
ON consolidated_positions (account_id, symbol, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_consolidated_positions_portfolio
ON consolidated_positions (portfolio_id, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_portfolios_client
ON portfolios (client_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_accounts_portfolio
ON portfolio_accounts (portfolio_id, status);

CREATE INDEX IF NOT EXISTS idx_portfolio_accounts_account
ON portfolio_accounts (account_id, status);

CREATE INDEX IF NOT EXISTS idx_strategies_registry_portfolio
ON strategies_registry (portfolio_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_portfolio_as_of
ON portfolio_snapshots (portfolio_id, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_symbol_exposure_snapshot
ON portfolio_symbol_exposure (snapshot_id, gross_notional_usd DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_correlation_snapshots_snapshot
ON portfolio_correlation_snapshots (snapshot_id, correlation_30d DESC);

CREATE INDEX IF NOT EXISTS idx_capital_flow_events_account_time
ON capital_flow_events (account_id, occurred_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capital_flow_events_portfolio_time
ON capital_flow_events (portfolio_id, occurred_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_limit_breaches_scope_time
ON risk_limit_breaches (scope_type, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_limit_breaches_portfolio_time
ON risk_limit_breaches (portfolio_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mt5_order_events_created_at
ON mt5_order_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mt5_order_events_account_id
ON mt5_order_events (account_id);

CREATE INDEX IF NOT EXISTS idx_mt5_order_events_chosen_route
ON mt5_order_events (chosen_route, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mt5_live_approvals_status_created
ON mt5_live_approvals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kill_switch_events_created_at
ON kill_switch_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_chain_events_created_at
ON audit_chain_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_created_at
ON decision_outcomes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_strategy_id
ON decision_outcomes (strategy_id);

CREATE INDEX IF NOT EXISTS idx_self_learning_v4_states_updated_at
ON self_learning_v4_states (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_self_learning_v4_states_scope
ON self_learning_v4_states (user_id, account_id, symbol, timeframe);

CREATE INDEX IF NOT EXISTS idx_market_ohlcv_venue_instrument_tf
ON market_ohlcv (venue, instrument, timeframe, bucket_start DESC);

CREATE INDEX IF NOT EXISTS idx_market_trades_venue_instrument_time
ON market_trades (venue, instrument, traded_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_orderbook_snapshots_instrument
ON market_orderbook_snapshots (venue, instrument, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_derivatives_metrics_symbol_time
ON market_derivatives_metrics (venue, instrument, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_telemetry_symbol_time
ON execution_telemetry (symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_telemetry_route
ON execution_telemetry (route_chosen, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_fill_events_decision
ON execution_fill_events (decision_id, filled_at ASC);

CREATE INDEX IF NOT EXISTS idx_execution_fill_events_symbol_time
ON execution_fill_events (instrument, filled_at DESC);

CREATE INDEX IF NOT EXISTS idx_reality_gap_samples_decision
ON reality_gap_samples (decision_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reality_gap_samples_symbol_time
ON reality_gap_samples (symbol, venue, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reality_gap_samples_regime
ON reality_gap_samples (regime, failure_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reality_gap_calibration_profiles_scope
ON reality_gap_calibration_profiles (venue, symbol, regime, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_embeddings_strategy_id
ON strategy_embeddings (strategy_id);

CREATE INDEX IF NOT EXISTS idx_strategy_embeddings_symbol_regime
ON strategy_embeddings (symbol, regime, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_embeddings_timeframe
ON strategy_embeddings (timeframe, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_embeddings_content_hash_model
ON strategy_embeddings (content_hash, model_name);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_created_at
ON retrieval_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_symbol_regime
ON retrieval_events (symbol, regime, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_health_state_drift
ON strategy_health_state (drift_detected, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_ab_events_created_at
ON memory_ab_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_ab_events_arm
ON memory_ab_events (arm, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_tickets_created_at
ON incident_tickets (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_tickets_status
ON incident_tickets (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chatbot_action_confirmations_status
ON chatbot_action_confirmations (status, expires_at DESC);
"""


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return str(value)


@contextmanager
def get_conn():
    last_error: Exception | None = None
    for _ in range(20):
        try:
            conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
            break
        except Exception as exc:  # pragma: no cover - startup resilience
            last_error = exc
            time.sleep(1)
    else:
        raise last_error or RuntimeError("Unable to connect to database")

    try:
        yield conn
    finally:
        conn.close()


def ensure_schema() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(424242)")
            try:
                cur.execute(SCHEMA_SQL)
            finally:
                cur.execute("SELECT pg_advisory_unlock(424242)")
        conn.commit()


def execute(query: str, params: Iterable[Any] | None = None) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
        conn.commit()


def execute_rowcount(query: str, params: Iterable[Any] | None = None) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
            count = cur.rowcount
        conn.commit()
        return count


def fetch_all(query: str, params: Iterable[Any] | None = None) -> list[dict[str, Any]]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
            return list(cur.fetchall())


def fetch_one(query: str, params: Iterable[Any] | None = None) -> dict[str, Any] | None:
    rows = fetch_all(query, params)
    return rows[0] if rows else None


def json_dumps(value: Any) -> str:
    return json.dumps(value, default=_json_default)