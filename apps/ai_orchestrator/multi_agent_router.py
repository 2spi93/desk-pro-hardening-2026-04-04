"""
FastAPI Integration for Multi-Agent System

Adds endpoints to Control Plane for:
- Multi-agent signal collection
- Meta-agent voting
- Portfolio management
- Learning updates
- Real-time UI feeds

These endpoints integrate with existing Decision V3 and Execution V3.
"""

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel
from typing import Dict, List, Optional, Any
import asyncio
import json
import os
from datetime import datetime, timezone

try:
    from .agents_framework import (
        HedgeFundSystem, TradeDirection, Regime, AgentType,
        AgentSignal, MetaAgentDecision, PortfolioState,
    )
    from .agents_specialized import (
        OrderflowAgent, MomentumAgent, ReversalAgent, RegimeAgent, RiskAgent,
    )
except ImportError:
    from agents_framework import (
        HedgeFundSystem, TradeDirection, Regime, AgentType,
        AgentSignal, MetaAgentDecision, PortfolioState,
    )
    from agents_specialized import (
        OrderflowAgent, MomentumAgent, ReversalAgent, RegimeAgent, RiskAgent,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Pydantic Models for API
# ═══════════════════════════════════════════════════════════════════════════

class AgentSignalResponse(BaseModel):
    """Single agent signal for API response"""
    agent_id: str
    agent_type: str
    direction: str
    confidence: float
    regime: Optional[str] = None
    score: float
    reasoning: str
    hit_rate_pct: float
    last_signal_sharpe: Optional[float] = None
    metadata: Dict[str, Any] = {}


class MetaAgentVoteRequest(BaseModel):
    """Request to conduct voting"""
    symbol: str
    market_data: Dict[str, Any]
    portfolio_state: Optional[Dict[str, Any]] = None


class MetaAgentVoteResponse(BaseModel):
    """Meta-agent decision"""
    decision_id: str
    direction: str
    meta_confidence: float
    agent_consensus_pct: float
    disagreement_level: float
    
    # Breakdown
    long_agents: List[AgentSignalResponse]
    short_agents: List[AgentSignalResponse]
    neutral_agents: List[AgentSignalResponse]
    
    risk_approved: bool
    risk_reason: str
    
    # Recommended action
    recommended_trade: Optional[Dict[str, Any]] = None


class PortfolioUpdateRequest(BaseModel):
    """Update portfolio state"""
    symbol: str
    entry_price: float
    current_price: float
    notional_usd: float
    pnl_usd: float
    direction: str  # long/short


class LearningUpdateRequest(BaseModel):
    """Update agent learning state"""
    agent_id: str
    pnl_usd: float
    pnl_pct: float
    regime: str
    signal_confidence: float
    hold_duration_hours: float


# ═══════════════════════════════════════════════════════════════════════════
# Global System Instance
# ═══════════════════════════════════════════════════════════════════════════

HEDGE_FUND_SYSTEM: Optional[HedgeFundSystem] = None

def _normalized_symbol(symbol: Optional[str]) -> str:
    candidate = str(symbol or os.getenv("KAIROS_SYMBOL", "BTCUSDT")).strip().upper()
    return candidate or "BTCUSDT"


def get_hf_system(symbol: Optional[str] = None) -> HedgeFundSystem:
    """Get or initialize the hedge fund system"""
    global HEDGE_FUND_SYSTEM
    target_symbol = _normalized_symbol(symbol)
    if HEDGE_FUND_SYSTEM is None:
        HEDGE_FUND_SYSTEM = HedgeFundSystem()
        _init_agents(target_symbol)
    else:
        current_symbol = next((agent.symbol for agent in HEDGE_FUND_SYSTEM.agents.values()), target_symbol)
        if _normalized_symbol(current_symbol) != target_symbol:
            HEDGE_FUND_SYSTEM = HedgeFundSystem()
            _init_agents(target_symbol)
    return HEDGE_FUND_SYSTEM


def _init_agents(symbol: str) -> None:
    """Initialize 5 specialized agents"""
    system = HEDGE_FUND_SYSTEM
    symbol = _normalized_symbol(symbol)
    
    # Dummy market data (would come from market data service)
    dummy_market_data = {
        'price': 42000.0,
        'bid_volume': 100.0,
        'ask_volume': 80.0,
        'vwap': 41950.0,
        'sma_20': 41800.0,
        'sma_50': 41500.0,
        'hma_slope': 0.003,
        'volume': 500.0,
        'avg_volume_30d': 450.0,
        'rsi_14': 55.0,
        'bb_upper': 42300.0,
        'bb_lower': 41700.0,
        'exhaustion_score': 0.4,
        'atr': 200.0,
        'swing_high_50': 42500.0,
        'swing_low_50': 41200.0,
        'momentum_roc': 0.002,
        'volatility': 0.02,
        'chop_index': 45.0,
        'adx': 28.0,
        'trend_strength': 0.65,
        'recent_low_touches': 1,
        'liquidity_trap_score': 0.3,
        'exhaustion_score': 0.4,
        'fake_breakout_score': 0.2,
        'last_breakout_direction': None,
        'prev_close': 41950.0,
        'open': 41900.0
    }
    
    # Create agents
    agents = [
        OrderflowAgent(symbol, dummy_market_data),
        MomentumAgent(symbol, dummy_market_data),
        ReversalAgent(symbol, dummy_market_data),
        RegimeAgent(symbol, dummy_market_data),
        RiskAgent(symbol, dummy_market_data, {})
    ]
    
    for agent in agents:
        system.register_agent(agent)


# ═══════════════════════════════════════════════════════════════════════════
# FastAPI Router
# ═══════════════════════════════════════════════════════════════════════════

router = APIRouter(prefix="/v1/multi-agent", tags=["multi-agent"])


@router.get("/health")
async def multi_agent_health() -> dict:
    """Health check for multi-agent system"""
    system = get_hf_system()
    return {
        "status": "ok",
        "system_id": system.system_id,
        "symbol": next((agent.symbol for agent in system.agents.values()), None),
        "agent_count": len(system.agents),
        "decision_log_size": len(system.decision_log)
    }


@router.get("/agents")
async def list_agents() -> Dict[str, Any]:
    """List all active agents and their performance"""
    system = get_hf_system()
    
    agents_info = []
    for agent_id, agent in system.agents.items():
        agents_info.append({
            "agent_id": agent_id,
            "agent_type": agent.agent_type.value,
            "enabled": agent.enabled,
            "win_rate_pct": agent.learning_state.win_rate_pct,
            "total_signals": agent.learning_state.total_signals,
            "current_weight": agent.learning_state.current_weight,
            "adaptive_adjustment": agent.learning_state.adaptive_adjustment,
            "performance_by_regime": agent.learning_state.performance_by_regime
        })
    
    return {
        "system_id": system.system_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agents": agents_info,
        "total_agents": len(agents_info)
    }


@router.get("/agents/{agent_id}")
async def get_agent_details(agent_id: str) -> Dict[str, Any]:
    """Get detailed info on specific agent"""
    system = get_hf_system()
    
    agent = None
    for a_id, a in system.agents.items():
        if a_id == agent_id or a.agent_type.value in agent_id:
            agent = a
            break
    
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    return {
        "agent_id": agent.agent_id,
        "agent_type": agent.agent_type.value,
        "symbol": agent.symbol,
        "enabled": agent.enabled,
        "learning_state": {
            "total_signals": agent.learning_state.total_signals,
            "winning_signals": agent.learning_state.winning_signals,
            "losing_signals": agent.learning_state.losing_signals,
            "win_rate_pct": agent.learning_state.win_rate_pct,
            "sharpe_ratio": agent.learning_state.sharpe_ratio,
            "current_weight": agent.learning_state.current_weight,
            "adaptive_adjustment": agent.learning_state.adaptive_adjustment
        },
        "performance_by_regime": agent.learning_state.performance_by_regime,
        "recent_signals": [
            {
                "direction": s.direction.value,
                "confidence": s.confidence,
                "regime": s.regime.value if s.regime else None,
                "reasoning": s.reasoning,
                "timestamp": s.timestamp
            }
            for s in agent.signal_history[-10:]
        ]
    }


@router.post("/vote")
async def conduct_meta_agent_vote(request: MetaAgentVoteRequest) -> MetaAgentVoteResponse:
    """
    Conduct multi-agent vote and return meta-agent decision.
    
    This is the MAIN DECISION POINT for the trading system.
    All 5 agents vote, meta-agent produces consensus.
    """
    
    system = get_hf_system(request.symbol)

    for agent in system.agents.values():
        if hasattr(agent, "portfolio_state") and isinstance(request.portfolio_state, dict):
            agent.portfolio_state = request.portfolio_state

    risk_constraint = {
        'min_consensus_pct': 50,
        'min_confidence': 0.4
    }
    if request.portfolio_state:
        risk_constraint['max_drawdown_pct'] = request.portfolio_state.get('max_drawdown_pct', 3.0)

    enriched_market_data = dict(request.market_data)
    enriched_market_data.setdefault("symbol", _normalized_symbol(request.symbol))
    decision = system.make_decision(enriched_market_data, risk_constraint)
    
    # Build response
    long_signals = [_agent_signal_to_response(s) for s in decision.agents_for_long]
    short_signals = [_agent_signal_to_response(s) for s in decision.agents_for_short]
    neutral_signals = [_agent_signal_to_response(s) for s in decision.agents_neutral]
    
    # Generate recommended trade if decision is strong
    recommended_trade = None
    if decision.risk_approved and decision.direction != TradeDirection.NEUTRAL:
        recommended_trade = {
            "direction": decision.direction.value,
            "confidence": decision.meta_confidence,
            "entry_trigger": f"{decision.direction.value.upper()} when consensus {decision.agent_consensus_pct:.0f}%",
            "position_size_pct": min(15, decision.meta_confidence * 25),  # Scale with confidence
            "stop_loss_pct": 2.0,
            "take_profit_pct": 6.0,
        }
    
    return MetaAgentVoteResponse(
        decision_id=decision.decision_id,
        direction=decision.direction.value,
        meta_confidence=decision.meta_confidence,
        agent_consensus_pct=decision.agent_consensus_pct,
        disagreement_level=decision.disagreement_level,
        long_agents=long_signals,
        short_agents=short_signals,
        neutral_agents=neutral_signals,
        risk_approved=decision.risk_approved,
        risk_reason=decision.risk_reason,
        recommended_trade=recommended_trade
    )


@router.post("/learning/update")
async def update_agent_learning(request: LearningUpdateRequest) -> Dict[str, Any]:
    """
    Update agent learning after a trade outcome.
    
    This allows agents to adapt their weights dynamically.
    """
    
    system = get_hf_system()
    
    target_agent = None
    for agent in system.agents.values():
        if agent.agent_id == request.agent_id or request.agent_id in agent.agent_id:
            target_agent = agent
            break
    
    if not target_agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    # Update learning
    target_agent.update_learning({
        'pnl_usd': request.pnl_usd,
        'pnl_pct': request.pnl_pct,
        'regime': Regime[request.regime.upper()],
        'signal_confidence': request.signal_confidence,
        'hold_duration_hours': request.hold_duration_hours
    })
    
    return {
        "agent_id": target_agent.agent_id,
        "win_rate_pct": target_agent.learning_state.win_rate_pct,
        "current_weight": target_agent.learning_state.current_weight,
        "adaptive_adjustment": target_agent.learning_state.adaptive_adjustment,
        "sharpe_ratio": target_agent.learning_state.sharpe_ratio
    }


@router.get("/decisions/recent")
async def get_recent_decisions(limit: int = 20) -> List[Dict[str, Any]]:
    """Get recent voting decisions"""
    
    system = get_hf_system()
    
    decisions = system.decision_log[-limit:]
    result = []
    for d in decisions:
        result.append({
            "decision_id": d.decision_id,
            "timestamp": d.timestamp,
            "direction": d.direction.value,
            "meta_confidence": d.meta_confidence,
            "agent_consensus_pct": d.agent_consensus_pct,
            "disagreement_level": d.disagreement_level,
            "agents_for_long": len(d.agents_for_long),
            "agents_for_short": len(d.agents_for_short),
            "risk_approved": d.risk_approved,
            "reason": d.risk_reason
        })
    
    return result


@router.get("/decisions/{decision_id}")
async def get_decision_details(decision_id: str) -> Dict[str, Any]:
    """Get detailed breakdown of a specific decision"""
    
    system = get_hf_system()
    
    for decision in system.decision_log:
        if decision.decision_id == decision_id:
            return {
                "decision_id": decision.decision_id,
                "timestamp": decision.timestamp,
                "direction": decision.direction.value,
                "meta_confidence": decision.meta_confidence,
                "agent_consensus_pct": decision.agent_consensus_pct,
                "disagreement_level": decision.disagreement_level,
                "long_score": decision.long_score,
                "short_score": decision.short_score,
                "agents_for_long": [
                    {
                        "agent_id": s.agent_id,
                        "agent_type": s.agent_type.value,
                        "confidence": s.confidence,
                        "reasoning": s.reasoning
                    }
                    for s in decision.agents_for_long
                ],
                "agents_for_short": [
                    {
                        "agent_id": s.agent_id,
                        "agent_type": s.agent_type.value,
                        "confidence": s.confidence,
                        "reasoning": s.reasoning
                    }
                    for s in decision.agents_for_short
                ],
                "risk_approved": decision.risk_approved,
                "risk_reason": decision.risk_reason
            }
    
    raise HTTPException(status_code=404, detail="Decision not found")


@router.websocket("/ws/decisions")
async def websocket_decisions(websocket: WebSocket) -> None:
    """
    WebSocket feed of real-time multi-agent decisions.
    
    For UI to show live voting and agent consensus.
    """
    
    await websocket.accept()
    system = get_hf_system()
    
    try:
        sent_decision_ids: set[str] = set()
        
        while True:
            # Check for new decisions
            for decision in system.decision_log:
                if decision.decision_id not in sent_decision_ids:
                    await websocket.send_json({
                        "type": "new_decision",
                        "decision_id": decision.decision_id,
                        "direction": decision.direction.value,
                        "confidence": decision.meta_confidence,
                        "consensus_pct": decision.agent_consensus_pct,
                        "timestamp": decision.timestamp,
                        "long_agents": len(decision.agents_for_long),
                        "short_agents": len(decision.agents_for_short)
                    })
                    sent_decision_ids.add(decision.decision_id)
            
            await asyncio.sleep(1)
    
    except Exception:
        pass
    finally:
        await websocket.close()


# ═══════════════════════════════════════════════════════════════════════════
# Helper Functions
# ═══════════════════════════════════════════════════════════════════════════

def _agent_signal_to_response(signal: AgentSignal) -> AgentSignalResponse:
    """Convert AgentSignal to API response format"""
    return AgentSignalResponse(
        agent_id=signal.agent_id,
        agent_type=signal.agent_type.value,
        direction=signal.direction.value,
        confidence=signal.confidence,
        regime=signal.regime.value if signal.regime else None,
        score=signal.score,
        reasoning=signal.reasoning,
        hit_rate_pct=signal.hit_rate_pct,
        last_signal_sharpe=signal.last_signal_sharpe,
        metadata=signal.metadata
    )


# Export for FastAPI mount
__all__ = ['router', 'get_hf_system']
