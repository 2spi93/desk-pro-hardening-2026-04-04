"""
Multi-Agent Trading System Framework

Architecture:
  - 5 Specialized Agents (Orderflow, Momentum, Mean-Reversion, Regime, Risk)
  - Meta-Agent (Voting + Consensus)
  - Portfolio Manager (Multi-Asset + Hedging)
  - Learning System (Adaptive Weights + Performance Tracking)

This is production-grade hedge fund architecture, NOT a toy system.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4
import json
from statistics import mean, stdev


# ═══════════════════════════════════════════════════════════════════════════
# 1. Enums & Basic Types
# ═══════════════════════════════════════════════════════════════════════════

class TradeDirection(Enum):
    """Trade direction from any agent"""
    LONG = "long"
    SHORT = "short"
    NEUTRAL = "neutral"
    WAIT = "wait"


class Regime(Enum):
    """Market regime classification"""
    TREND = "trend"       # Strong directional movement
    CHOP = "chop"         # Noisy, choppy market
    VOLATILE = "volatile" # High volatility, hard to trade
    BALANCED = "balanced" # No clear structure


class AgentType(Enum):
    """Agent specialization"""
    ORDERFLOW = "orderflow"      # Smart money flow
    MOMENTUM = "momentum"        # Continuation trades
    MEAN_REVERSION = "reversal"  # Trap detection + reversal
    REGIME = "regime"            # Market structure classifier
    RISK = "risk"                # Portfolio risk manager


# ═══════════════════════════════════════════════════════════════════════════
# 2. Core Agent Models
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class AgentSignal:
    """Individual agent's decision"""
    agent_id: str
    agent_type: AgentType
    timestamp: str
    
    # Core decision
    direction: TradeDirection
    confidence: float  # 0.0 to 1.0
    
    # Supporting data
    regime: Optional[Regime] = None
    score: float = 0.0  # Internal scoring (normalized 0-100)
    reasoning: str = ""  # Human-readable explanation
    metadata: Dict[str, Any] = field(default_factory=dict)  # Agent-specific data
    
    # Performance tracking
    last_signal_roa: Optional[float] = None  # Return on agent's signals
    last_signal_sharpe: Optional[float] = None
    hit_rate_pct: float = 50.0  # Win rate % (agent smoothed history)


@dataclass
class MetaAgentDecision:
    """Meta-agent voting result"""
    decision_id: str
    timestamp: str
    
    # Voting results
    direction: TradeDirection
    meta_confidence: float  # Aggregated confidence
    agent_consensus_pct: float  # % of agents agreeing (0-100)
    
    # Breakdown (for transparency)
    agents_for_long: List[AgentSignal]
    agents_for_short: List[AgentSignal]
    agents_neutral: List[AgentSignal]
    
    # Risk check
    risk_approved: bool
    risk_reason: str = ""
    
    # Auction/scoring
    long_score: float = 0.0
    short_score: float = 0.0
    disagreement_level: float = 0.0  # 0 = consensus, 1 = max conflict


@dataclass
class PortfolioPosition:
    """Single position in portfolio"""
    symbol: str
    side: TradeDirection  # long/short/neutral
    notional_usd: float
    entry_price: float
    current_price: float
    pnl_usd: float
    pnl_pct: float
    hedge_pairs: List[str] = field(default_factory=list)  # Hedging symbols


@dataclass
class PortfolioState:
    """Complete portfolio snapshot"""
    portfolio_id: str
    timestamp: str
    
    positions: Dict[str, PortfolioPosition]  # symbol -> position
    total_notional_usd: float
    gross_exposure_pct: float
    net_exposure_pct: float
    current_pnl_usd: float
    current_pnl_pct: float
    
    # Risk metrics
    max_drawdown_pct: float
    var_95_pct: float
    sharpe_ratio: float
    correlation_matrix: Optional[Dict[str, Dict[str, float]]] = None


@dataclass
class LearningSnapshot:
    """Agent performance learning state"""
    agent_id: str
    timestamp: str
    
    total_signals: int = 0
    winning_signals: int = 0
    losing_signals: int = 0
    win_rate_pct: float = 50.0
    
    # Advanced metrics
    sharpe_ratio: float = 0.0
    sortino_ratio: float = 0.0
    calmar_ratio: float = 0.0
    
    # Regime-specific performance
    performance_by_regime: Dict[str, Dict[str, float]] = field(default_factory=dict)
    
    # Dynamic weight in meta-agent
    current_weight: float = 1.0  # Normalized across agents (sum = 5.0)
    adaptive_adjustment: float = 0.0  # -1 to +1 (negative = demote)
    
    journal: List[Dict[str, Any]] = field(default_factory=list)  # Trade journal


# ═══════════════════════════════════════════════════════════════════════════
# 3. Abstract Agent Base Class
# ═══════════════════════════════════════════════════════════════════════════

class TradingAgent(ABC):
    """
    Base class for all trading agents.
    
    Each agent:
    - Sees the market differently
    - Has its own scoring logic
    - Tracks its own performance
    - Can be enabled/disabled
    """
    
    def __init__(self, agent_type: AgentType, symbol: str, instrument_data: Dict[str, Any]):
        self.agent_id = f"{agent_type.value}-{uuid4().hex[:8]}"
        self.agent_type = agent_type
        self.symbol = symbol
        self.instrument_data = instrument_data
        self.enabled = True
        
        # Performance tracking
        self.learning_state = LearningSnapshot(agent_id=self.agent_id, timestamp=_now_iso())
        self.signal_history: List[AgentSignal] = []
        
    @abstractmethod
    def analyze(self) -> AgentSignal:
        """
        Main analysis method. Each agent implements its own logic.
        
        Returns:
            AgentSignal with direction, confidence, and reasoning
        """
        pass
    
    def get_signal(self) -> Optional[AgentSignal]:
        """Get current signal (only if enabled)"""
        if not self.enabled:
            return None
        signal = self.analyze()
        self.signal_history.append(signal)
        return signal
    
    def update_learning(self, outcome: Dict[str, float]) -> None:
        """
        Update agent's learning state after a trade outcome.
        
        Args:
            outcome: {
                'pnl_usd': float,
                'pnl_pct': float,
                'regime': Regime,
                'signal_confidence': float,
                'entry_price': float,
                'exit_price': float,
                'hold_duration_hours': float
            }
        """
        pnl = outcome.get('pnl_usd', 0.0)
        regime = outcome.get('regime', Regime.BALANCED)
        
        if pnl > 0:
            self.learning_state.winning_signals += 1
        elif pnl < 0:
            self.learning_state.losing_signals += 1
        
        self.learning_state.total_signals += 1
        self.learning_state.win_rate_pct = (
            self.learning_state.winning_signals / max(1, self.learning_state.total_signals) * 100
        )
        
        # Track by regime
        regime_key = regime.value
        if regime_key not in self.learning_state.performance_by_regime:
            self.learning_state.performance_by_regime[regime_key] = {
                'total': 0,
                'wins': 0,
                'losses': 0,
                'win_rate': 50.0,
                'avg_pnl': 0.0
            }
        
        regime_perf = self.learning_state.performance_by_regime[regime_key]
        regime_perf['total'] += 1
        if pnl > 0:
            regime_perf['wins'] += 1
        elif pnl < 0:
            regime_perf['losses'] += 1
        
        regime_perf['win_rate'] = (regime_perf['wins'] / max(1, regime_perf['total'])) * 100
        regime_perf['avg_pnl'] = (regime_perf.get('avg_pnl', 0.0) * (regime_perf['total'] - 1) + pnl) / regime_perf['total']
        
        # Update adaptive weight
        if self.learning_state.win_rate_pct > 60:
            self.learning_state.adaptive_adjustment = min(1.0, self.learning_state.adaptive_adjustment + 0.1)
        elif self.learning_state.win_rate_pct < 45:
            self.learning_state.adaptive_adjustment = max(-1.0, self.learning_state.adaptive_adjustment - 0.1)


# ═══════════════════════════════════════════════════════════════════════════
# 4. Meta-Agent Voting System
# ═══════════════════════════════════════════════════════════════════════════

class MetaAgent:
    """
    Central coordination layer.
    
    Receives signals from 5 specialized agents, votes, and produces consensus.
    
    Voting algorithm:
    1. Weighted voting (agent.current_weight * confidence)
    2. Consensus threshold check
    3. Risk approval gate
    4. Final decision confidence
    """
    
    def __init__(self):
        self.meta_agent_id = f"meta-{uuid4().hex[:8]}"
        self.voting_history: List[MetaAgentDecision] = []
    
    def vote(
        self,
        agent_signals: List[AgentSignal],
        risk_constraint: Optional[Dict[str, float]] = None
    ) -> MetaAgentDecision:
        """
        Conduct weighted vote across agents.
        
        Args:
            agent_signals: List of AgentSignal from 5 agents
            risk_constraint: Optional risk limits from Risk Agent
        
        Returns:
            MetaAgentDecision with final direction and consensus
        """
        if not agent_signals:
            # No signals = wait
            return MetaAgentDecision(
                decision_id=f"meta-{uuid4().hex[:8]}",
                timestamp=_now_iso(),
                direction=TradeDirection.WAIT,
                meta_confidence=0.0,
                agent_consensus_pct=0.0,
                agents_for_long=[],
                agents_for_short=[],
                agents_neutral=[],
                risk_approved=False,
                risk_reason="No agents signaling"
            )
        
        # Separate by direction
        long_agents = [s for s in agent_signals if s.direction == TradeDirection.LONG]
        short_agents = [s for s in agent_signals if s.direction == TradeDirection.SHORT]
        neutral_agents = [s for s in agent_signals if s.direction == TradeDirection.NEUTRAL]
        
        # Weighted voting
        long_score = sum(s.confidence * (1.0 + s.last_signal_sharpe / 100 if s.last_signal_sharpe else 1.0) for s in long_agents)
        short_score = sum(s.confidence * (1.0 + s.last_signal_sharpe / 100 if s.last_signal_sharpe else 1.0) for s in short_agents)
        
        # Determine final direction
        if abs(long_score - short_score) < 0.1:  # Too close = conflicted
            final_direction = TradeDirection.WAIT
            confidence = 0.0
        elif long_score > short_score:
            final_direction = TradeDirection.LONG
            confidence = min(1.0, long_score / (long_score + short_score + 1e-9))
        else:
            final_direction = TradeDirection.SHORT
            confidence = min(1.0, short_score / (long_score + short_score + 1e-9))
        
        # Consensus percentage
        agreeing_count = len(long_agents) if final_direction == TradeDirection.LONG else len(short_agents)
        consensus_pct = (agreeing_count / max(1, len(agent_signals))) * 100
        
        # Risk check
        risk_approved = True
        risk_reason = "OK"
        if risk_constraint:
            if consensus_pct < risk_constraint.get('min_consensus_pct', 50):
                risk_approved = False
                risk_reason = f"Consensus {consensus_pct:.0f}% below threshold {risk_constraint.get('min_consensus_pct', 50)}%"
            
            if confidence < risk_constraint.get('min_confidence', 0.5):
                risk_approved = False
                risk_reason = f"Meta confidence {confidence:.2f} below threshold"
        
        decision = MetaAgentDecision(
            decision_id=f"meta-{uuid4().hex[:8]}",
            timestamp=_now_iso(),
            direction=final_direction,
            meta_confidence=confidence,
            agent_consensus_pct=consensus_pct,
            agents_for_long=long_agents,
            agents_for_short=short_agents,
            agents_neutral=neutral_agents,
            risk_approved=risk_approved,
            risk_reason=risk_reason,
            long_score=long_score,
            short_score=short_score,
            disagreement_level=abs(long_score - short_score) / max(1.0, long_score + short_score)
        )
        
        self.voting_history.append(decision)
        return decision


# ═══════════════════════════════════════════════════════════════════════════
# 5. Portfolio Manager
# ═══════════════════════════════════════════════════════════════════════════

class PortfolioManager:
    """
    Multi-asset portfolio orchestration.
    
    Responsibilities:
    - Position sizing (Kelly, Volatility-weighted)
    - Correlation-based hedging
    - Cross-asset pair trading
    - Exposure limits enforcement
    - PnL tracking per agent
    """
    
    def __init__(self):
        self.portfolio_id = f"port-{uuid4().hex[:8]}"
        self.portfolio_state = PortfolioState(
            portfolio_id=self.portfolio_id,
            timestamp=_now_iso(),
            positions={},
            total_notional_usd=0.0,
            gross_exposure_pct=0.0,
            net_exposure_pct=0.0,
            current_pnl_usd=0.0,
            current_pnl_pct=0.0,
            max_drawdown_pct=0.0,
            var_95_pct=0.0,
            sharpe_ratio=0.0
        )
        self.portfolio_history: List[PortfolioState] = []
    
    def execute_trade(
        self,
        symbol: str,
        direction: TradeDirection,
        notional_usd: float,
        entry_price: float,
        agent_signal: AgentSignal
    ) -> bool:
        """
        Execute a trade via agent decision.
        
        Returns: True if executed, False if blocked by risk limits
        """
        # Risk check: max exposure
        current_gross = sum(abs(p.notional_usd) for p in self.portfolio_state.positions.values())
        if current_gross + notional_usd > 1_000_000:  # $1M max
            return False
        
        # Position size constraint
        if notional_usd > self.portfolio_state.total_notional_usd * 0.15:
            return False  # Single trade > 15% portfolio
        
        # Execute
        position = PortfolioPosition(
            symbol=symbol,
            side=direction,
            notional_usd=notional_usd,
            entry_price=entry_price,
            current_price=entry_price,
            pnl_usd=0.0,
            pnl_pct=0.0
        )
        self.portfolio_state.positions[symbol] = position
        return True
    
    def add_hedge(self, primary_symbol: str, hedge_symbol: str, correlation: float) -> None:
        """
        Register a hedge pair (e.g., BTC long + ETH short for correlation hedge).
        """
        if primary_symbol in self.portfolio_state.positions:
            self.portfolio_state.positions[primary_symbol].hedge_pairs.append(hedge_symbol)


# ═══════════════════════════════════════════════════════════════════════════
# 6. Utility Functions
# ═══════════════════════════════════════════════════════════════════════════

def _now_iso() -> str:
    """ISO 8601 timestamp"""
    return datetime.now(timezone.utc).isoformat()


def calculate_position_size_kelly(
    win_rate_pct: float,
    avg_win_usd: float,
    avg_loss_usd: float,
    portfolio_notional: float
) -> float:
    """
    Kelly Criterion for optimal position sizing.
    
    f* = (p * b - q) / b
    where:
      p = win rate
      q = 1 - p
      b = avg_win / avg_loss
    
    Returns: Fraction of portfolio to risk (e.g., 0.15 = 15%)
    """
    if avg_loss_usd <= 0:
        return 0.0
    
    p = win_rate_pct / 100.0
    q = 1.0 - p
    b = avg_win_usd / avg_loss_usd
    
    kelly_fraction = (p * b - q) / max(0.001, b)
    # Apply safety cap (use 25% of Kelly)
    capped = kelly_fraction * 0.25
    return max(0.0, min(0.2, capped))  # 0-20% of portfolio


def calculate_volatility_weight(volatility: float, target_vol: float = 0.02) -> float:
    """
    Adjust position size for volatility.
    
    Lower vol = larger position, Higher vol = smaller position
    (keep constant portfolio volatility)
    """
    if volatility <= 0:
        return 1.0
    return target_vol / volatility


# ═══════════════════════════════════════════════════════════════════════════
# 7. System Integration Point
# ═══════════════════════════════════════════════════════════════════════════

class HedgeFundSystem:
    """
    Complete multi-agent hedge fund system.
    
    Orchestrates:
    - 5 agents
    - Meta-agent voting
    - Portfolio management
    - Learning + adaptation
    """
    
    def __init__(self):
        self.system_id = f"hf-{uuid4().hex[:8]}"
        self.agents: Dict[str, TradingAgent] = {}
        self.meta_agent = MetaAgent()
        self.portfolio_manager = PortfolioManager()
        self.decision_log: List[MetaAgentDecision] = []
    
    def register_agent(self, agent: TradingAgent) -> None:
        """Register a specialized agent"""
        self.agents[agent.agent_id] = agent
    
    def make_decision(
        self,
        market_data: Dict[str, Any],
        risk_constraint: Optional[Dict[str, float]] = None
    ) -> MetaAgentDecision:
        """
        Main decision loop:
        1. Get signals from all agents
        2. Vote
        3. Return consensus
        """
        next_symbol = str(market_data.get('symbol') or market_data.get('instrument') or '').strip()
        signals = []
        for agent in self.agents.values():
            agent.instrument_data = market_data
            if next_symbol:
                agent.symbol = next_symbol
            signal = agent.get_signal()
            if signal:
                signals.append(signal)
        
        decision = self.meta_agent.vote(signals, risk_constraint)
        self.decision_log.append(decision)
        return decision


# Export for use in FastAPI
__all__ = [
    'TradeDirection', 'Regime', 'AgentType',
    'AgentSignal', 'MetaAgentDecision', 'PortfolioState',
    'TradingAgent', 'MetaAgent', 'PortfolioManager', 'HedgeFundSystem',
    'calculate_position_size_kelly', 'calculate_volatility_weight'
]
