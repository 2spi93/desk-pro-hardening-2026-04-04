# Accounts + Portfolio + Performance Target Architecture

## Objective

Turn TXT from an execution and perception cockpit into an operable multi-account trading platform.

Target outcome:

- Accounts, roles, balances, and consolidated positions become canonical.
- Portfolio risk is computed globally, not symbol-by-symbol only.
- Performance is ledger-backed and attributable by account, portfolio, strategy, and venue.
- AI decisions are calibrated from real outcomes instead of display-only heuristics.

## Product Freeze Rule

Before Phase 1 starts, freeze large UI feature expansion.

Allowed during the freeze:

- bug fixes
- chart/runtime validation
- performance work that reduces operational risk
- wiring new backend state into existing screens

Not allowed during the freeze:

- new terminal surfaces
- major visual redesign
- additional perception widgets that do not improve execution or operating controls

Reason: the product gap is not terminal capability anymore. The gap is business-operating state.

## Existing Assets To Reuse

Current repo already contains building blocks that should remain first-class.

- Authentication and sessions in `users`, `sessions`, `user_ui_preferences`
- MT5 account registry in `mt5_accounts`
- Execution records in `intents`, `orders`, `execution_telemetry`, `execution_fill_events`, `mt5_order_events`
- Outcome storage in `decision_outcomes`
- Signed audit trail in `audit_chain_events`
- Portfolio semantics already used by the orchestrator in `PortfolioState`

Do not replace these immediately. Normalize around them and migrate progressively.

## Bounded Contexts

Split responsibility into explicit domains.

### 1. Identity And Access

Owns:

- users
- roles
- permissions
- user-to-client mapping
- auth sessions

Primary service:

- control-plane

### 2. Account Registry

Owns:

- trading accounts
- custody wallets
- broker/exchange connectors
- venue credentials metadata
- account balances
- account positions

Primary services:

- control-plane for canonical registry
- mt5-bridge / broker-adapter / exchange connectors for sync

### 3. Portfolio Engine

Owns:

- portfolio membership
- portfolio allocation
- exposure aggregation
- drawdown state
- VaR light
- correlation state

Primary service:

- risk-gateway or a dedicated portfolio-risk service

### 4. Execution Ledger

Owns:

- execution intents
- routing choices
- fills
- slippage
- lifecycle states

Primary services:

- control-plane
- execution-router
- rust-execution-engine

### 5. Performance Engine

Owns:

- realized and unrealized PnL
- equity curves
- performance attribution
- investor reporting
- strategy scorecards

Primary service:

- control-plane initially
- later extract to dedicated performance service if needed

### 6. AI Calibration

Owns:

- signal-to-outcome linkage
- model calibration state
- confidence demotion/promotion
- regime-aware performance feedback

Primary services:

- predictor-v8
- ai-orchestrator
- control-plane for persistence APIs

## Canonical Domain Model

This is the target model the rest of the system should speak.

### User

Represents a human operator, client, investor, or service principal.

Core fields:

- user_id
- username
- role
- status
- auth_state
- client_id

### Client Entity

Represents the economic owner or business entity.

Core fields:

- client_id
- legal_name
- client_type: individual, prop, fund, family_office, internal
- base_currency
- status
- kyc_status

### Account

Represents a venue account or wallet that can hold capital and positions.

Core fields:

- account_id
- client_id
- account_type: broker, exchange, wallet, strategy_subaccount, omnibus
- venue
- connector_type
- mode: paper, live
- base_currency
- status
- external_ref

### Portfolio

Represents a risk and allocation container.

Core fields:

- portfolio_id
- client_id
- name
- base_currency
- mandate_type: discretionary, advisory, simulation, treasury
- risk_profile
- status

### Strategy

Represents an execution or alpha policy whose outcomes are measurable.

Core fields:

- strategy_id
- portfolio_id
- owner_user_id
- strategy_type
- status
- capital_allocation_mode

### Execution Intent

Represents the canonical pre-trade request.

Core fields:

- intent_id
- portfolio_id
- strategy_id
- account_scope
- symbol
- side
- target_notional_usd
- confidence
- reason_code
- explainability

### Execution Order

Represents venue-facing order lifecycle state.

Core fields:

- order_id
- intent_id
- account_id
- route_id
- venue
- instrument
- order_type
- status
- requested_qty
- filled_qty

### Fill Event

Represents execution truth.

Core fields:

- fill_id
- order_id
- account_id
- venue
- instrument
- side
- fill_price
- fill_qty
- fill_notional_usd
- fees_usd
- liquidity_flag
- filled_at

### Outcome

Represents the post-trade measured result tied back to decision and strategy.

Core fields:

- outcome_id
- decision_id
- intent_id
- strategy_id
- account_id
- portfolio_id
- pnl_realized_usd
- pnl_unrealized_usd
- mfe_usd
- mae_usd
- horizon_5m
- horizon_1h
- horizon_24h
- label

## Target Data Schema

The schema below is the minimum viable operating schema. It is intentionally normalized around the current tables.

## Phase 1 Schema

### Reuse Existing Tables

- `users`
- `sessions`
- `user_ui_preferences`
- `mt5_accounts`
- `intents`
- `orders`
- `execution_telemetry`
- `execution_fill_events`
- `decision_outcomes`
- `audit_chain_events`

### Add New Tables

#### `clients`

```sql
CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  client_type TEXT NOT NULL CHECK (client_type IN ('internal','individual','prop','fund','family_office')),
  base_currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('active','pending','suspended','closed')),
  kyc_status TEXT NOT NULL DEFAULT 'not_required',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `user_client_memberships`

```sql
CREATE TABLE user_client_memberships (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  membership_role TEXT NOT NULL CHECK (membership_role IN ('admin','trader','investor','viewer','operator')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, client_id, membership_role)
);
```

#### `accounts_registry`

```sql
CREATE TABLE accounts_registry (
  account_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  account_type TEXT NOT NULL CHECK (account_type IN ('broker','exchange','wallet','strategy_subaccount','omnibus')),
  venue TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  base_currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('active','pending','disabled','error','closed')),
  external_ref TEXT,
  display_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Note:

- `mt5_accounts` stays as connector-native state
- `accounts_registry` becomes the canonical account registry
- `mt5_accounts.account_id` should map 1:1 into `accounts_registry.account_id`

#### `account_balances`

```sql
CREATE TABLE account_balances (
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
```

#### `consolidated_positions`

```sql
CREATE TABLE consolidated_positions (
  position_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts_registry(account_id) ON DELETE CASCADE,
  portfolio_id TEXT,
  strategy_id TEXT,
  symbol TEXT NOT NULL,
  instrument TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short','flat')),
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
```

#### `portfolios`

```sql
CREATE TABLE portfolios (
  portfolio_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  mandate_type TEXT NOT NULL CHECK (mandate_type IN ('discretionary','advisory','simulation','treasury')),
  risk_profile TEXT NOT NULL DEFAULT 'balanced',
  benchmark_symbol TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','paused','closed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `portfolio_accounts`

```sql
CREATE TABLE portfolio_accounts (
  id BIGSERIAL PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts_registry(account_id) ON DELETE CASCADE,
  allocation_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  allocation_cap_usd DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (portfolio_id, account_id)
);
```

#### `strategies_registry`

```sql
CREATE TABLE strategies_registry (
  strategy_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  strategy_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','paper','active','paused','retired')),
  capital_allocation_mode TEXT NOT NULL DEFAULT 'shared',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Canonical Phase 1 Views

Add views to bridge old and new schemas fast.

#### `v_accounts_canonical`

Unifies `accounts_registry` and connector-native tables.

#### `v_positions_canonical`

Unifies current open positions by account, portfolio, strategy, symbol.

#### `v_execution_ledger`

Joins `intents`, `orders`, `execution_telemetry`, `execution_fill_events`.

## Phase 2 Schema

### Add Portfolio Risk Tables

#### `portfolio_snapshots`

```sql
CREATE TABLE portfolio_snapshots (
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
```

#### `portfolio_symbol_exposure`

```sql
CREATE TABLE portfolio_symbol_exposure (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES portfolio_snapshots(snapshot_id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  net_notional_usd DOUBLE PRECISION NOT NULL,
  gross_notional_usd DOUBLE PRECISION NOT NULL,
  beta_weighted_notional_usd DOUBLE PRECISION,
  concentration_pct DOUBLE PRECISION NOT NULL,
  UNIQUE (snapshot_id, symbol)
);
```

#### `portfolio_correlation_snapshots`

```sql
CREATE TABLE portfolio_correlation_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES portfolio_snapshots(snapshot_id) ON DELETE CASCADE,
  symbol_x TEXT NOT NULL,
  symbol_y TEXT NOT NULL,
  correlation_30d DOUBLE PRECISION NOT NULL,
  UNIQUE (snapshot_id, symbol_x, symbol_y)
);
```

#### `risk_limit_breaches`

```sql
CREATE TABLE risk_limit_breaches (
  breach_id TEXT PRIMARY KEY,
  portfolio_id TEXT,
  account_id TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('portfolio','account','strategy','client')),
  breach_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  current_value DOUBLE PRECISION,
  limit_value DOUBLE PRECISION,
  action_taken TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Phase 3 Schema

### Add Performance And Reporting Tables

#### `performance_timeseries`

```sql
CREATE TABLE performance_timeseries (
  id BIGSERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('client','portfolio','account','strategy')),
  scope_id TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_granularity TEXT NOT NULL CHECK (bucket_granularity IN ('1m','5m','1h','1d','1mo')),
  equity_open_usd DOUBLE PRECISION,
  equity_close_usd DOUBLE PRECISION,
  pnl_realized_usd DOUBLE PRECISION,
  pnl_unrealized_usd DOUBLE PRECISION,
  flow_net_usd DOUBLE PRECISION,
  drawdown_pct DOUBLE PRECISION,
  UNIQUE (scope_type, scope_id, bucket_granularity, bucket_start)
);
```

#### `performance_attribution`

```sql
CREATE TABLE performance_attribution (
  id BIGSERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('portfolio','account')),
  scope_id TEXT NOT NULL,
  strategy_id TEXT,
  symbol TEXT,
  venue TEXT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  realized_pnl_usd DOUBLE PRECISION NOT NULL,
  unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  win_rate_pct DOUBLE PRECISION,
  expectancy_usd DOUBLE PRECISION,
  sharpe_ratio DOUBLE PRECISION,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
```

#### `investor_reports`

```sql
CREATE TABLE investor_reports (
  report_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  portfolio_id TEXT REFERENCES portfolios(portfolio_id) ON DELETE SET NULL,
  report_month DATE NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('monthly','quarterly','custom')),
  status TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  storage_path TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
```

## Phase 4 Schema

### Add AI Calibration Tables

#### `signal_outcomes`

```sql
CREATE TABLE signal_outcomes (
  signal_outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  strategy_id TEXT,
  portfolio_id TEXT,
  symbol TEXT NOT NULL,
  model_name TEXT NOT NULL,
  regime TEXT,
  signal_label TEXT,
  confidence_pre_trade DOUBLE PRECISION NOT NULL,
  outcome_label TEXT,
  pnl_realized_usd DOUBLE PRECISION,
  pnl_5m_usd DOUBLE PRECISION,
  pnl_1h_usd DOUBLE PRECISION,
  pnl_24h_usd DOUBLE PRECISION,
  max_favorable_excursion_usd DOUBLE PRECISION,
  max_adverse_excursion_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### `model_calibration_snapshots`

```sql
CREATE TABLE model_calibration_snapshots (
  calibration_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global','symbol','regime','strategy')),
  scope_id TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  brier_score DOUBLE PRECISION,
  calibration_error DOUBLE PRECISION,
  hit_rate_pct DOUBLE PRECISION,
  promoted BOOLEAN NOT NULL DEFAULT FALSE,
  demoted BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
```

## Canonical API Surface

This is the minimum API surface to make the operating layer usable.

## Identity And Client APIs

### `GET /v1/clients`

Returns clients visible to the current user.

### `POST /v1/clients`

Create client entity.

### `GET /v1/users/me/memberships`

Returns user-to-client memberships and effective permissions.

### `POST /v1/clients/{client_id}/memberships`

Assign user to client with role.

## Account Registry APIs

### `GET /v1/accounts`

Filter by:

- client_id
- portfolio_id
- venue
- mode
- status

### `POST /v1/accounts`

Create canonical account record.

### `POST /v1/accounts/{account_id}/sync`

Trigger connector sync for balances and positions.

### `GET /v1/accounts/{account_id}/balances`

Return latest normalized balances.

### `GET /v1/accounts/{account_id}/positions`

Return latest normalized positions.

## Portfolio APIs

### `GET /v1/portfolios`

### `POST /v1/portfolios`

### `POST /v1/portfolios/{portfolio_id}/accounts`

Attach account to portfolio.

### `GET /v1/portfolios/{portfolio_id}/state`

Return canonical real-time portfolio state:

```json
{
  "portfolio_id": "pf-main",
  "as_of": "2026-03-29T20:00:00Z",
  "equity_usd": 250000.0,
  "gross_exposure_usd": 110000.0,
  "net_exposure_usd": 35000.0,
  "gross_exposure_pct": 44.0,
  "net_exposure_pct": 14.0,
  "daily_pnl_usd": 3400.0,
  "drawdown_pct": 1.8,
  "var_95_usd": 8200.0,
  "top_exposures": [],
  "correlation_summary": {},
  "risk_flags": []
}
```

### `GET /v1/portfolios/{portfolio_id}/risk`

Return current VaR light, drawdown, concentration, correlation, breach state.

## Strategy APIs

### `GET /v1/strategies`

### `POST /v1/strategies`

### `GET /v1/strategies/{strategy_id}/performance`

## Execution Ledger APIs

### `GET /v1/executions`

Canonical execution ledger query across intents, orders, fills, telemetry.

### `GET /v1/executions/{decision_id}`

### `GET /v1/fills`

### `GET /v1/outcomes`

Unified decision outcome query.

## Performance APIs

### `GET /v1/performance/summary`

Filters:

- scope_type
- scope_id
- start
- end

Response includes:

- realized pnl
- unrealized pnl
- win rate
- expectancy
- drawdown
- Sharpe

### `GET /v1/performance/timeseries`

### `GET /v1/performance/attribution`

### `POST /v1/reports/monthly`

Generate investor report for client or portfolio.

## AI Calibration APIs

### `POST /v1/ai/signal-outcomes/recompute`

Rebuild outcome linkage from execution ledger and performance data.

### `GET /v1/ai/calibration/{model_name}`

### `POST /v1/ai/calibration/{model_name}/promote`

### `POST /v1/ai/calibration/{model_name}/demote`

## Service Ownership

Use explicit ownership to avoid spaghetti.

### Control Plane

Owns:

- clients
- memberships
- canonical account registry
- portfolios
- strategies
- performance summaries
- reporting orchestration

### MT5 Bridge / Venue Connectors

Owns:

- venue-native account sync
- latest balances and positions snapshots
- connector health

### Risk Gateway

Owns:

- portfolio risk snapshot calculation
- limit checks
- VaR light
- drawdown and concentration checks
- breach creation

### Execution Router / Rust Engine

Owns:

- execution lifecycle
- routing
- fills
- slippage and latency telemetry

### Predictor / AI Orchestrator

Owns:

- signal evaluation
- calibration metrics
- model demotion/promotion

## Canonical Event Flow

## Order Lifecycle

1. strategy issues intent
2. control-plane persists intent
3. risk-gateway evaluates account + portfolio + client limits
4. execution-router selects route
5. rust engine or broker adapter executes
6. fills land in execution ledger
7. positions and balances are refreshed
8. performance engine computes realized and unrealized state
9. outcome engine links decision to result
10. AI calibration updates confidence quality

## Phase-by-Phase Implementation Order

## Phase 1

Goal: canonical operating state.

### Deliverables

- add `clients`, `user_client_memberships`, `accounts_registry`, `account_balances`, `consolidated_positions`, `portfolios`, `portfolio_accounts`, `strategies_registry`
- add canonical views `v_accounts_canonical`, `v_positions_canonical`, `v_execution_ledger`
- map existing `mt5_accounts` into `accounts_registry`
- expose client/account/portfolio read APIs
- expose balances and positions APIs

### Order

1. migration SQL
2. pydantic models in `shared/models.py`
3. DB helpers in `shared/db.py`
4. control-plane endpoints for clients, memberships, accounts, portfolios
5. mt5-bridge sync endpoint returning normalized balance and position payloads
6. UI wiring only for existing internal pages, no big new surfaces

### Definition Of Done

- a user can belong to a client
- a client can own multiple accounts
- a portfolio can attach multiple accounts
- balances and positions are queryable in canonical form

## Phase 2

Goal: global risk state.

### Deliverables

- add `portfolio_snapshots`, `portfolio_symbol_exposure`, `portfolio_correlation_snapshots`, `risk_limit_breaches`
- compute real-time portfolio state from canonical balances and positions
- expose `/v1/portfolios/{portfolio_id}/state` and `/risk`
- feed orchestrator `PortfolioState` from canonical DB instead of ad-hoc payloads

### Order

1. snapshot calculators in risk-gateway
2. scheduled or event-driven refresh from execution fills and market prices
3. API endpoints
4. replace local portfolio placeholders in orchestrator with canonical fetch

### Definition Of Done

- gross and net exposure are real
- daily pnl and drawdown are real
- VaR light and concentration exist
- breach events are persisted and queryable

## Phase 3

Goal: investor-grade performance layer.

### Deliverables

- add `performance_timeseries`, `performance_attribution`, `investor_reports`
- compute equity curve and attribution
- expose summary, timeseries, attribution APIs
- generate monthly report payloads and export artifacts

### Order

1. build execution-to-performance aggregation jobs
2. add summary APIs
3. add reporting generator
4. wire investor dashboard and export endpoints

### Definition Of Done

- PnL is attributable by strategy, symbol, venue, account, portfolio
- monthly investor report is reproducible from DB state
- dashboard investor data does not depend on terminal-only logic

## Phase 4

Goal: real AI calibration.

### Deliverables

- add `signal_outcomes`, `model_calibration_snapshots`
- backfill decisions to outcomes
- compute calibration and Brier-like quality metrics
- demote weak models and promote proven ones based on outcomes

### Order

1. join `decision_outcomes` with execution ledger and strategy ownership
2. persist signal outcome rows
3. compute calibration snapshots
4. expose calibration APIs
5. modify predictor and self-learning logic to read calibration state before surfacing confidence

### Definition Of Done

- displayed confidence is tied to measured outcomes
- weak signals are automatically demoted
- strong signals survive because they earn it in live or shadow data

## Recommended File-Level Changes

Start here.

### `shared/models.py`

Add canonical models for:

- Client
- UserClientMembership
- AccountRegistryRecord
- AccountBalanceSnapshot
- ConsolidatedPosition
- PortfolioRecord
- PortfolioStateSnapshot
- PerformanceSummary

### `shared/db.py`

Add schema SQL for all new phase 1 tables first.

### `apps/control_plane/main.py`

Add minimal internal APIs for:

- clients
- memberships
- accounts
- portfolios
- portfolio state
- performance summary

### `apps/mt5_bridge/main.py`

Add normalized sync/read endpoints:

- `GET /v1/accounts/{account_id}/balances`
- `GET /v1/accounts/{account_id}/positions`

### `apps/risk_gateway/main.py`

Extend with:

- portfolio snapshot builder
- concentration checks
- drawdown checks
- VaR light endpoint

### `ui/mission-control`

Do not build a new large shell yet.

Only add:

- internal read-only account pages
- portfolio state widgets in existing internal pages
- performance summary card for operators and investors

## Non-Goals Right Now

Do not do these before Phase 1 and 2 are stable.

- broad retail onboarding UX
- more perception widgets
- elaborate novice mode
- many new execution presets
- exotic chart surfaces

## Practical First Sprint

If implementation starts now, first sprint should be exactly this:

1. create `clients` and memberships
2. create `accounts_registry`
3. backfill MT5 accounts into canonical registry
4. create `portfolios` and `portfolio_accounts`
5. create normalized balance and position snapshots
6. expose `GET /v1/accounts`, `GET /v1/portfolios`, `GET /v1/portfolios/{id}/state` with stubbed risk fields

That gives TXT its first true operating layer.

## Final Architecture Call

TXT should be built as:

- execution and intelligence layer at the core
- account, portfolio, and performance layer above it
- optional investor and retail surfaces above that

Do not invert this order.

If the operating layer is weak, the terminal remains impressive but economically unusable.