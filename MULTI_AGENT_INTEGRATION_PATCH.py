"""
Integration Patch for Control Plane

This file shows EXACTLY what to add to control_plane/main.py
to integrate the multi-agent system.

Copy-paste ready code snippets.
"""

# ═══════════════════════════════════════════════════════════════════════════
# 1. ADD IMPORTS (at top of control_plane/main.py)
# ═══════════════════════════════════════════════════════════════════════════

# Add these imports after existing FastAPI imports:
from multi_agent_router import (
    router as multi_agent_router,
    get_hf_system,
    MetaAgentVoteRequest
)


# ═══════════════════════════════════════════════════════════════════════════
# 2. MOUNT MULTI-AGENT ROUTER (after all other route includes)
# ═══════════════════════════════════════════════════════════════════════════

# Add this after existing app.include_router() calls:
app.include_router(multi_agent_router, prefix="/api")


# ═══════════════════════════════════════════════════════════════════════════
# 3. ADD HELPER FUNCTION (in the "helpers" section)
# ═══════════════════════════════════════════════════════════════════════════

def _enrich_market_data_for_agents(payload: dict) -> dict:
    """
    Extract and enrich market data from trading payload
    for multi-agent analysis.
    """
    symbol = payload.get("symbol", "")
    
    # Try to fetch real market data from market data service
    try:
        import httpx
        
        async def fetch():
            async with httpx.AsyncClient(timeout=5.0) as client:
                quotes_resp = await client.get(
                    f"{MARKET_DATA_URL}/v1/quotes",
                    params={"instrument": symbol}
                )
                if quotes_resp.status_code < 400:
                    quote = quotes_resp.json().get("quote", {})
                    return quote
            return {}
        
        # In sync context, use default market data
        market_data = {
            'price': float(payload.get('current_price', 0.0)),
            'bid_volume': float(payload.get('bid_vol', 0.0)),
            'ask_volume': float(payload.get('ask_vol', 0.0)),
            'vwap': float(payload.get('vwap', payload.get('current_price', 0.0))),
            'sma_20': float(payload.get('sma_20', 0.0)),
            'sma_50': float(payload.get('sma_50', 0.0)),
            'hma_slope': float(payload.get('hma_slope', 0.0)),
            'volume': float(payload.get('volume', 0.0)),
            'avg_volume_30d': float(payload.get('avg_volume_30d', 0.0)),
            'rsi_14': float(payload.get('rsi_14', 50.0)),
            'bb_upper': float(payload.get('bb_upper', 0.0)),
            'bb_lower': float(payload.get('bb_lower', 0.0)),
            'exhaustion_score': float(payload.get('exhaustion_score', 0.0)),
            'atr': float(payload.get('atr', 0.0)),
            'swing_high_50': float(payload.get('swing_high_50', 0.0)),
            'swing_low_50': float(payload.get('swing_low_50', 0.0)),
            'momentum_roc': float(payload.get('momentum_roc', 0.0)),
            'volatility': float(payload.get('volatility', 0.02)),
            'chop_index': float(payload.get('chop_index', 50.0)),
            'adx': float(payload.get('adx', 25.0)),
            'trend_strength': float(payload.get('trend_strength', 0.0)),
            'recent_low_touches': int(payload.get('recent_low_touches', 0)),
            'liquidity_trap_score': float(payload.get('liquidity_trap_score', 0.0)),
            'fake_breakout_score': float(payload.get('fake_breakout_score', 0.0)),
            'last_breakout_direction': payload.get('last_breakout_direction'),
            'prev_close': float(payload.get('prev_close', 0.0)),
            'open': float(payload.get('open', 0.0))
        }
    except Exception as e:
        log(f"Error enriching market data: {e}")
        market_data = {}
    
    return market_data


def _get_portfolio_state_for_risk() -> dict:
    """
    Get current portfolio state for risk agent.
    """
    # Fetch from database or internal state
    try:
        portfolio = fetch_one(
            """
            SELECT 
                COALESCE(MAX((pnl_pct) FILTER (WHERE pnl_pct < 0)), 0) as max_drawdown_pct,
                COALESCE(SUM(pnl_usd) FILTER (WHERE created_at::date = CURRENT_DATE), 0) as daily_pnl_usd,
                COUNT(DISTINCT symbol) as position_count
            FROM decision_outcomes
            WHERE status = 'pending' OR status = 'filled'
            """
        )
        
        drawdown = abs(float(portfolio.get("max_drawdown_pct", 0.0))) if portfolio else 0.0
        daily_loss = float(portfolio.get("daily_pnl_usd", 0.0)) if portfolio else 0.0
        
        return {
            'max_drawdown_pct': drawdown,
            'daily_pnl_usd': daily_loss,
            'gross_exposure_pct': min(100, float(portfolio.get("position_count", 0) * 15)),
            'current_leverage': 1.0,
            'volatility': 0.02
        }
    except Exception as e:
        log(f"Error getting portfolio state: {e}")
        return {
            'max_drawdown_pct': 0.0,
            'daily_pnl_usd': 0.0,
            'gross_exposure_pct': 0.0,
            'current_leverage': 1.0,
            'volatility': 0.02
        }


# ═══════════════════════════════════════════════════════════════════════════
# 4. REPLACE EXISTING DECISION SCORE ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

# Find this endpoint in control_plane/main.py:
#   @app.post("/v1/ai/decision/score")
#
# Replace the body with this enhanced version:

@app.post("/v1/ai/decision/score")
async def proxy_ai_decision_score_enhanced(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    """
    Enhanced decision score with multi-agent voting.
    """
    del auth
    
    symbol = str(payload.get("symbol") or payload.get("instrument") or "")
    
    # 1. Get multi-agent decision (NEW)
    try:
        market_data = _enrich_market_data_for_agents(payload)
        portfolio_state = _get_portfolio_state_for_risk()
        
        hf_system = get_hf_system()
        
        multi_agent_vote_req = MetaAgentVoteRequest(
            symbol=symbol,
            market_data=market_data,
            portfolio_state=portfolio_state
        )
        
        multi_agent_decision = hf_system.meta_agent.vote(
            [agent.get_signal() for agent in hf_system.agents.values() if agent.get_signal()],
            {
                'min_consensus_pct': 50,
                'min_confidence': 0.4,
                'max_drawdown_pct': portfolio_state.get('max_drawdown_pct', 3.0)
            }
        )
        
        # Log multi-agent decision
        execute(
            """
            INSERT INTO multi_agent_decisions (
                decision_id, symbol, direction, meta_confidence, agent_consensus_pct,
                long_count, short_count, neutral_count, risk_approved, payload
            )
            VALUES (%s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s::jsonb)
            """,
            (
                multi_agent_decision.decision_id,
                symbol,
                multi_agent_decision.direction.value,
                multi_agent_decision.meta_confidence,
                multi_agent_decision.agent_consensus_pct,
                len(multi_agent_decision.agents_for_long),
                len(multi_agent_decision.agents_for_short),
                len(multi_agent_decision.agents_neutral),
                multi_agent_decision.risk_approved,
                json_dumps({
                    'long_agents': [s.agent_type.value for s in multi_agent_decision.agents_for_long],
                    'short_agents': [s.agent_type.value for s in multi_agent_decision.agents_for_short],
                    'disagreement': multi_agent_decision.disagreement_level
                })
            )
        )
        
    except Exception as e:
        log(f"Multi-agent decision failed (non-fatal): {e}")
        multi_agent_decision = None
    
    # 2. Continue with existing logic (memory, adjustments, etc.)
    arm = "memory_on"
    memory = {
        "kpis": {},
        "formatted_memory": [],
        "insights": [],
        "historical_alignment_score": _to_float(payload.get("historical_match"), 0.5),
        "risk_flags": {"high_drawdown": False},
    }
    
    if _memory_ab_enabled():
        arm = _pick_memory_arm(payload)
    
    if arm == "memory_on":
        memory = await _retrieve_memory_for_payload(payload)
    
    # 3. Call AI orchestrator (existing)
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/decision/score", json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
    
    # 4. Blend multi-agent signal into response (NEW)
    if multi_agent_decision:
        # Boost confidence if agents aligned with AI decision
        ai_direction = body.get("direction", "").lower()
        agents_direction = multi_agent_decision.direction.value
        
        if (ai_direction == agents_direction and 
            multi_agent_decision.agent_consensus_pct >= 60):
            # Strong alignment: boost score
            body['score']['score_global'] = min(
                1.0,
                body['score'].get('score_global', 0.5) * 
                (1 + multi_agent_decision.agent_consensus_pct / 100 * 0.2)
            )
            body['multi_agent_boost'] = True
            body['agents_alignment_pct'] = multi_agent_decision.agent_consensus_pct
        
        # Add multi-agent metadata to response
        body['multi_agent'] = {
            'decision_id': multi_agent_decision.decision_id,
            'direction': multi_agent_decision.direction.value,
            'confidence': multi_agent_decision.meta_confidence,
            'consensus_pct': multi_agent_decision.agent_consensus_pct,
            'risk_approved': multi_agent_decision.risk_approved,
            'long_count': len(multi_agent_decision.agents_for_long),
            'short_count': len(multi_agent_decision.agents_for_short)
        }
    
    return body


# ═══════════════════════════════════════════════════════════════════════════
# 5. ADD POST-TRADE LEARNING UPDATE ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

# Add this new endpoint after existing trade endpoints:

@app.post("/v1/trade/learning-update")
async def record_trade_outcome_for_learning(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    """
    Record trade outcome for agent learning.
    
    Called after each trade fills to update agent performance metrics.
    """
    del auth
    
    decision_id = payload.get("decision_id", "")
    symbol = payload.get("symbol", "")
    pnl_usd = float(payload.get("pnl_usd", 0.0))
    pnl_pct = float(payload.get("pnl_pct", 0.0))
    regime = payload.get("regime", "balanced")
    signal_confidence = float(payload.get("signal_confidence", 0.5))
    hold_hours = float(payload.get("hold_duration_hours", 0.0))
    
    # Get multi-agent system
    hf_system = get_hf_system()
    
    # Find which agent signaled this trade
    results = {}
    
    # For now, update all agents (in prod: track which agent produced the signal)
    for agent in hf_system.agents.values():
        try:
            agent.update_learning({
                'pnl_usd': pnl_usd,
                'pnl_pct': pnl_pct,
                'regime': regime,
                'signal_confidence': signal_confidence,
                'hold_duration_hours': hold_hours
            })
            
            results[agent.agent_id] = {
                'win_rate': agent.learning_state.win_rate_pct,
                'weight': agent.learning_state.current_weight,
                'adjustment': agent.learning_state.adaptive_adjustment
            }
        except Exception as e:
            log(f"Error updating agent {agent.agent_id}: {e}")
    
    # Record in database
    execute(
        """
        INSERT INTO agent_learning_updates (
            decision_id, symbol, agent_updates, pnl_usd, pnl_pct, regime, created_at
        )
        VALUES (%s, %s, %s::jsonb, %s, %s, %s, NOW())
        """,
        (
            decision_id,
            symbol,
            json_dumps(results),
            pnl_usd,
            pnl_pct,
            regime
        )
    )
    
    return {
        "decision_id": decision_id,
        "learning_updates": results,
        "status": "ok"
    }


# ═══════════════════════════════════════════════════════════════════════════
# 6. DATABASE SCHEMA (Run these SQL statements)
# ═══════════════════════════════════════════════════════════════════════════

"""
-- Add these tables to database:

CREATE TABLE IF NOT EXISTS multi_agent_decisions (
    decision_id VARCHAR(256) PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    direction VARCHAR(16) NOT NULL,
    meta_confidence FLOAT NOT NULL,
    agent_consensus_pct FLOAT NOT NULL,
    long_count INT,
    short_count INT,
    neutral_count INT,
    risk_approved BOOLEAN,
    payload JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_symbol (symbol),
    INDEX idx_direction (direction),
    INDEX idx_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS agent_learning_updates (
    id SERIAL PRIMARY KEY,
    decision_id VARCHAR(256),
    symbol VARCHAR(32),
    agent_updates JSONB,
    pnl_usd FLOAT,
    pnl_pct FLOAT,
    regime VARCHAR(32),
    created_at TIMESTAMP DEFAULT NOW(),
    INDEX idx_decision_id (decision_id),
    INDEX idx_symbol (symbol),
    INDEX idx_created_at (created_at)
);
"""


# ═══════════════════════════════════════════════════════════════════════════
# 7. DEPLOYMENT STEPS
# ═══════════════════════════════════════════════════════════════════════════

"""
1. Copy the three agent files to /opt/txt/apps/ai_orchestrator/
   - agents_framework.py
   - agents_specialized.py
   - multi_agent_router.py

2. Add imports and router mount to control_plane/main.py

3. Add helper functions to control_plane/main.py

4. Replace or enhance the /v1/ai/decision/score endpoint

5. Add the /v1/trade/learning-update endpoint

6. Run the SQL schema creation statements

7. Restart the control plane service:
   docker-compose restart control-plane

8. Verify health:
   curl http://localhost:8000/api/v1/multi-agent/health

9. Monitor logs:
   docker logs -f control-plane
"""

