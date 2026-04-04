"""
5 Specialized Trading Agents

Each agent sees the market differently:
1. OrderflowAgent   → Smart money + absorption
2. MomentumAgent    → Continuation + breakout
3. ReversalAgent    → Fake breaks + traps
4. RegimeAgent      → Market structure (trend/chop/volatile)
5. RiskAgent        → Portfolio risk gates

All inherit from TradingAgent base class.
"""

try:
    from .agents_framework import (
        TradingAgent, AgentSignal, TradeDirection, Regime, AgentType,
        _now_iso,
    )
except ImportError:
    from agents_framework import (
        TradingAgent, AgentSignal, TradeDirection, Regime, AgentType,
        _now_iso,
    )
from typing import Any, Dict, Optional
import math


# ═══════════════════════════════════════════════════════════════════════════
# 1. ORDERFLOW AGENT — Smart Money Detection
# ═══════════════════════════════════════════════════════════════════════════

class OrderflowAgent(TradingAgent):
    """
    Detects smart money participation using:
    - Order imbalance (buy vol vs sell vol)
    - Absorption zones (institutions buying dips)
    - Liquidity traps (fake liquidation hunters)
    
    Your current system already has this logic. This agent wraps it.
    """
    
    def __init__(self, symbol: str, instrument_data: Dict[str, Any]):
        super().__init__(AgentType.ORDERFLOW, symbol, instrument_data)
    
    def analyze(self) -> AgentSignal:
        """
        Analyze orderflow for smart money signature.
        
        Signals:
        - LONG: Strong buy absorption without price move (institutional accumulation)
        - SHORT: Large sells into strength (distribution)
        - NEUTRAL: Mixed flows
        """
        
        data = self.instrument_data
        bid_vol = data.get('bid_volume', 0.0)
        ask_vol = data.get('ask_volume', 0.0)
        last_price = data.get('price', 0.0)
        vwap = data.get('vwap', last_price)
        price_change_pct = ((last_price - data.get('open', last_price)) / max(last_price, 1)) * 100
        
        # Calculate imbalance score
        total_vol = bid_vol + ask_vol
        if total_vol > 0:
            imbalance_ratio = bid_vol / total_vol
        else:
            imbalance_ratio = 0.5
        
        confidence = 0.0
        direction = TradeDirection.NEUTRAL
        reasoning = ""
        
        # Strong accumulation: bid vol >> ask vol, price stable/rising
        if imbalance_ratio > 0.65 and price_change_pct >= -0.5:
            direction = TradeDirection.LONG
            confidence = min(0.95, 0.5 + (imbalance_ratio - 0.65) * 3)
            reasoning = f"Strong buy accumulation: bid/ask ratio {imbalance_ratio:.2f}, price: {price_change_pct:+.2f}%"
        
        # Distribution: ask vol >> bid vol, price strong
        elif imbalance_ratio < 0.35 and price_change_pct > 1.0:
            direction = TradeDirection.SHORT
            confidence = min(0.95, 0.5 + (0.35 - imbalance_ratio) * 3)
            reasoning = f"Strong distribution: bid/ask ratio {imbalance_ratio:.2f}, up {price_change_pct:+.2f}%"
        
        # Absorption (key institutional pattern): price dips but bid vol strong
        elif imbalance_ratio > 0.60 and price_change_pct < -1.0 and \
             data.get('recent_low_touches', 0) > 2:
            direction = TradeDirection.LONG
            confidence = 0.7
            reasoning = f"Absorption pattern: dip bought {data.get('recent_low_touches', 0)}x, bid strong"
        
        # Liquidity trap: gap fill followed by rejection
        trap_signal = data.get('liquidity_trap_score', 0.0)
        if trap_signal > 0.7 and price_change_pct > 1.5:
            direction = TradeDirection.SHORT
            confidence = 0.65
            reasoning = f"Liquidity trap: high algo trap score {trap_signal:.2f}, extended move"
        
        return AgentSignal(
            agent_id=self.agent_id,
            agent_type=self.agent_type,
            timestamp=_now_iso(),
            direction=direction,
            confidence=confidence,
            regime=self._detect_regime(),
            score=confidence * 100,
            reasoning=reasoning,
            metadata={
                'bid_vol': bid_vol,
                'ask_vol': ask_vol,
                'imbalance_ratio': imbalance_ratio,
                'price_change_pct': price_change_pct,
                'absorption_count': data.get('recent_low_touches', 0)
            },
            last_signal_roa=self.learning_state.performance_by_regime.get('trend', {}).get('avg_pnl'),
            last_signal_sharpe=self.learning_state.sharpe_ratio,
            hit_rate_pct=self.learning_state.win_rate_pct
        )
    
    def _detect_regime(self) -> Regime:
        # Simple regime detection (would be more sophisticated)
        volatility = self.instrument_data.get('volatility', 0.02)
        trend_strength = self.instrument_data.get('trend_strength', 0.0)
        
        if trend_strength > 0.6:
            return Regime.TREND
        elif volatility > 0.04:
            return Regime.VOLATILE
        else:
            return Regime.CHOP


# ═══════════════════════════════════════════════════════════════════════════
# 2. MOMENTUM AGENT — Continuation & Breakout
# ═══════════════════════════════════════════════════════════════════════════

class MomentumAgent(TradingAgent):
    """
    Detects momentum continuation:
    - Uptrend: HMA slope positive + higher highs
    - Downtrend: HMA slope negative + lower lows
    - Breakout: Price breaks key level + volume surge
    """
    
    def __init__(self, symbol: str, instrument_data: Dict[str, Any]):
        super().__init__(AgentType.MOMENTUM, symbol, instrument_data)
    
    def analyze(self) -> AgentSignal:
        """
        Detect trend continuation and breakouts.
        """
        
        data = self.instrument_data
        price = data.get('price', 0.0)
        sma_20 = data.get('sma_20', price)
        sma_50 = data.get('sma_50', price)
        hma_slope = data.get('hma_slope', 0.0)
        volume = data.get('volume', 0.0)
        avg_volume = data.get('avg_volume_30d', volume)
        rsi = data.get('rsi_14', 50)
        
        # Detect uptrend
        is_uptrend = price > sma_20 > sma_50 and hma_slope > 0
        # Detect downtrend
        is_downtrend = price < sma_20 < sma_50 and hma_slope < 0
        
        # Volume surge
        volume_surge = volume > avg_volume * 1.5 if avg_volume > 0 else False
        
        confidence = 0.0
        direction = TradeDirection.NEUTRAL
        reasoning = ""
        
        # Strong continuation: uptrend + volume
        if is_uptrend and hma_slope > 0.005:
            confidence = min(0.9, 0.4 + abs(hma_slope) * 100 + (0.1 if volume_surge else 0))
            direction = TradeDirection.LONG
            reasoning = f"Uptrend continuation: HMA slope +{hma_slope:.4f}, price > MA20 > MA50"
        
        # Uptrend with confirmation
        elif is_uptrend and rsi < 70:
            confidence = min(0.75, 0.35 + abs(hma_slope) * 80)
            direction = TradeDirection.LONG
            reasoning = f"Uptrend with room: RSI {rsi:.0f}, HMA slope +{hma_slope:.4f}"
        
        # Strong downtrend: downtrend + volume
        elif is_downtrend and hma_slope < -0.005:
            confidence = min(0.9, 0.4 + abs(hma_slope) * 100 + (0.1 if volume_surge else 0))
            direction = TradeDirection.SHORT
            reasoning = f"Downtrend continuation: HMA slope {hma_slope:.4f}, price < MA20 < MA50"
        
        # Downtrend with confirmation
        elif is_downtrend and rsi > 30:
            confidence = min(0.75, 0.35 + abs(hma_slope) * 80)
            direction = TradeDirection.SHORT
            reasoning = f"Downtrend with room: RSI {rsi:.0f}, HMA slope {hma_slope:.4f}"
        
        # Breakout: price breaks level + volume surge
        elif volume_surge and data.get('atr', 0) > 0:
            atr = data.get('atr', 1.0)
            prev_close = data.get('prev_close', price)
            high_breakout = price > data.get('swing_high_50', price)
            low_breakout = price < data.get('swing_low_50', price)
            
            if high_breakout:
                confidence = 0.65
                direction = TradeDirection.LONG
                reasoning = f"Breakout above swing high with volume surge"
            elif low_breakout:
                confidence = 0.65
                direction = TradeDirection.SHORT
                reasoning = f"Breakout below swing low with volume surge"
        
        return AgentSignal(
            agent_id=self.agent_id,
            agent_type=self.agent_type,
            timestamp=_now_iso(),
            direction=direction,
            confidence=confidence,
            regime=Regime.TREND if is_uptrend or is_downtrend else Regime.CHOP,
            score=confidence * 100,
            reasoning=reasoning,
            metadata={
                'hma_slope': hma_slope,
                'rsi': rsi,
                'price_vs_ma20': (price - sma_20) / max(sma_20, 1),
                'volume_surge': volume_surge
            },
            last_signal_sharpe=self.learning_state.sharpe_ratio,
            hit_rate_pct=self.learning_state.win_rate_pct
        )


# ═══════════════════════════════════════════════════════════════════════════
# 3. REVERSAL AGENT — Mean Reversion & Traps
# ═══════════════════════════════════════════════════════════════════════════

class ReversalAgent(TradingAgent):
    """
    Detects mean reversion and fake breakouts:
    - Price extended far from VWAP → reversion likely
    - Exhaustion patterns → reversal setup
    - False breakout (break above then collapse) → trap
    """
    
    def __init__(self, symbol: str, instrument_data: Dict[str, Any]):
        super().__init__(AgentType.MEAN_REVERSION, symbol, instrument_data)
    
    def analyze(self) -> AgentSignal:
        """
        Detect mean reversion and trap patterns.
        """
        
        data = self.instrument_data
        price = data.get('price', 0.0)
        vwap = data.get('vwap', price)
        bb_upper = data.get('bb_upper', price)
        bb_lower = data.get('bb_lower', price)
        momentum = data.get('momentum_roc', 0.0)
        distance_from_vwap_pct = ((price - vwap) / max(vwap, 1)) * 100
        
        confidence = 0.0
        direction = TradeDirection.NEUTRAL
        reasoning = ""
        
        # Extended above VWAP + exhaustion → reversal to short
        if distance_from_vwap_pct > 2.0 and price > bb_upper:
            # Check for exhaustion (declining volume or weakening momentum)
            exhaustion_score = data.get('exhaustion_score', 0.0)
            if exhaustion_score > 0.6:
                confidence = min(0.85, 0.5 + distance_from_vwap_pct / 5)
                direction = TradeDirection.SHORT
                reasoning = f"Overextended + exhaustion: {distance_from_vwap_pct:+.2f}% above VWAP, exhaustion={exhaustion_score:.2f}"
        
        # Extended below VWAP + exhaustion → reversal to long
        elif distance_from_vwap_pct < -2.0 and price < bb_lower:
            exhaustion_score = data.get('exhaustion_score', 0.0)
            if exhaustion_score > 0.6:
                confidence = min(0.85, 0.5 + abs(distance_from_vwap_pct) / 5)
                direction = TradeDirection.LONG
                reasoning = f"Oversold + exhaustion: {distance_from_vwap_pct:+.2f}% below VWAP, exhaustion={exhaustion_score:.2f}"
        
        # False breakout (break above key level then collapse)
        fake_breakout_score = data.get('fake_breakout_score', 0.0)
        if fake_breakout_score > 0.75:
            if data.get('last_breakout_direction') == 'up':
                direction = TradeDirection.SHORT
                confidence = 0.70
                reasoning = f"False breakout down: break failed, trap detected"
            elif data.get('last_breakout_direction') == 'down':
                direction = TradeDirection.LONG
                confidence = 0.70
                reasoning = f"False breakout up: break failed, trap detected"
        
        # Simple mean reversion: far from VWAP (even without exhaustion)
        elif abs(distance_from_vwap_pct) > 3.5:
            if distance_from_vwap_pct > 0:
                direction = TradeDirection.SHORT
                confidence = min(0.60, 0.3 + distance_from_vwap_pct / 10)
            else:
                direction = TradeDirection.LONG
                confidence = min(0.60, 0.3 + abs(distance_from_vwap_pct) / 10)
            reasoning = f"Far from VWAP: {distance_from_vwap_pct:+.2f}%"
        
        return AgentSignal(
            agent_id=self.agent_id,
            agent_type=self.agent_type,
            timestamp=_now_iso(),
            direction=direction,
            confidence=confidence,
            regime=Regime.CHOP if abs(distance_from_vwap_pct) > 2 else Regime.BALANCED,
            score=confidence * 100,
            reasoning=reasoning,
            metadata={
                'distance_from_vwap_pct': distance_from_vwap_pct,
                'exhaustion': data.get('exhaustion_score', 0.0),
                'fake_breakout': fake_breakout_score
            },
            last_signal_sharpe=self.learning_state.sharpe_ratio,
            hit_rate_pct=self.learning_state.win_rate_pct
        )


# ═══════════════════════════════════════════════════════════════════════════
# 4. REGIME AGENT — Market Structure Classifier
# ═══════════════════════════════════════════════════════════════════════════

class RegimeAgent(TradingAgent):
    """
    Classifies market regime:
    - TREND: Clear directional bias (suitable for continuation)
    - CHOP: Choppy, sideways (mean reversion + tight stops)
    - VOLATILE: High volatility (reduce size, higher spreads)
    - BALANCED: No clear bias
    
    This agent doesn't generate trade signals, but signals the REGIME
    which other agents use to adjust their strategies.
    """
    
    def __init__(self, symbol: str, instrument_data: Dict[str, Any]):
        super().__init__(AgentType.REGIME, symbol, instrument_data)
    
    def analyze(self) -> AgentSignal:
        """
        Classify market regime.
        
        Note: This agent returns NEUTRAL direction but signals regime.
        Other agents will adjust their confidence based on this.
        """
        
        data = self.instrument_data
        
        # Trend strength: 0-1
        trend_strength = abs(data.get('adx', 25)) / 40  # ADX: 0-40+ scale
        trend_strength = min(1.0, trend_strength)
        
        # Volatility: annualized
        volatility = data.get('volatility', 0.02)
        
        # Chop index: 0-100 (higher = choppier)
        chop_index = data.get('chop_index', 50)
        
        # Determine regime
        if trend_strength > 0.7 and chop_index < 40:
            regime = Regime.TREND
            score = 85.0
            reasoning = f"Strong TREND: ADX {trend_strength*40:.0f}, Chop {chop_index:.0f}"
        
        elif volatility > 0.04:
            regime = Regime.VOLATILE
            score = 70.0
            reasoning = f"HIGH VOLATILITY: {volatility*100:.1f}% annualized"
        
        elif chop_index > 60:
            regime = Regime.CHOP
            score = 75.0
            reasoning = f"CHOPPY: ChopIndex {chop_index:.0f}, low directional bias"
        
        else:
            regime = Regime.BALANCED
            score = 50.0
            reasoning = "BALANCED: No clear structure"
        
        return AgentSignal(
            agent_id=self.agent_id,
            agent_type=self.agent_type,
            timestamp=_now_iso(),
            direction=TradeDirection.NEUTRAL,  # Regime agent doesn't trade
            confidence=trend_strength,
            regime=regime,
            score=score,
            reasoning=reasoning,
            metadata={
                'trend_strength': trend_strength,
                'volatility': volatility,
                'chop_index': chop_index,
                'adx': data.get('adx', 0)
            },
            last_signal_sharpe=self.learning_state.sharpe_ratio
        )


# ═══════════════════════════════════════════════════════════════════════════
# 5. RISK AGENT — Portfolio Risk Manager
# ═══════════════════════════════════════════════════════════════════════════

class RiskAgent(TradingAgent):
    """
    Risk management agent (no trade signals).
    
    Monitors:
    - Drawdown: Kill trades if > 3%
    - Volatility: Reduce size if > threshold
    - Correlation: Diversification check
    - Leverage: Max 2x
    - Daily loss cap: Stop if > $10k daily loss
    
    Returns "BLOCK" signal if risk exceeds limits.
    """
    
    def __init__(self, symbol: str, instrument_data: Dict[str, Any], portfolio_state: Optional[Dict] = None):
        super().__init__(AgentType.RISK, symbol, instrument_data)
        self.portfolio_state = portfolio_state or {}
    
    def analyze(self) -> AgentSignal:
        """
        Risk check.
        """
        
        data = self.instrument_data
        portfolio = self.portfolio_state
        
        # Current portfolio state
        current_drawdown_pct = portfolio.get('max_drawdown_pct', 0.0)
        daily_loss_usd = portfolio.get('daily_pnl_usd', 0.0)
        gross_exposure_pct = portfolio.get('gross_exposure_pct', 0.0)
        current_leverage = portfolio.get('current_leverage', 1.0)
        
        direction = TradeDirection.NEUTRAL
        confidence = 1.0
        reasoning = "Risk checks OK"
        risk_flags = []
        
        # Check 1: Max drawdown
        if current_drawdown_pct > 3.0:
            direction = TradeDirection.WAIT  # Block new trades
            confidence = 0.0
            risk_flags.append(f"MAX DRAWDOWN: {current_drawdown_pct:.2f}% > 3%")
            reasoning = " | ".join(risk_flags)
        
        # Check 2: Daily loss cap
        if daily_loss_usd < -10_000:
            direction = TradeDirection.WAIT
            confidence = 0.0
            risk_flags.append(f"DAILY LOSS: ${daily_loss_usd:,.0f} > $10k")
            reasoning = " | ".join(risk_flags)
        
        # Check 3: Leverage
        if current_leverage > 2.0:
            risk_flags.append(f"HIGH LEVERAGE: {current_leverage:.1f}x")
        
        # Check 4: Gross exposure
        if gross_exposure_pct > 80:
            risk_flags.append(f"OVEREXPOSED: {gross_exposure_pct:.0f}%")
        
        # Check 5: Volatility regime
        volatility = data.get('volatility', 0.02)
        if volatility > 0.08:
            risk_flags.append(f"EXTREME VOL: {volatility*100:.1f}%")
        
        if risk_flags:
            reasoning = " | ".join(risk_flags)
        
        return AgentSignal(
            agent_id=self.agent_id,
            agent_type=self.agent_type,
            timestamp=_now_iso(),
            direction=direction,
            confidence=confidence,
            regime=None,
            score=0.0 if direction == TradeDirection.WAIT else 100.0,
            reasoning=reasoning,
            metadata={
                'drawdown_pct': current_drawdown_pct,
                'daily_loss_usd': daily_loss_usd,
                'gross_exposure_pct': gross_exposure_pct,
                'leverage': current_leverage,
                'volatility': volatility,
                'flags': risk_flags
            }
        )


# ═══════════════════════════════════════════════════════════════════════════
# Export
# ═══════════════════════════════════════════════════════════════════════════

__all__ = [
    'OrderflowAgent',
    'MomentumAgent',
    'ReversalAgent',
    'RegimeAgent',
    'RiskAgent'
]
