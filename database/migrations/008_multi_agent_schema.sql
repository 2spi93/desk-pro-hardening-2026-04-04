-- ═══════════════════════════════════════════════════════════════════════════
-- MULTI-AGENT SYSTEM DATABASE SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════
-- 
-- Tables for:
-- 1. Multi-agent decisions & voting history
-- 2. Agent learning & performance metrics
-- 3. Trade outcomes linked to agent signals
--

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. MULTI-AGENT DECISIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS multi_agent_decisions (
    decision_id VARCHAR(256) PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    direction VARCHAR(16) NOT NULL,  -- long, short, neutral, wait
    meta_confidence FLOAT NOT NULL,  -- 0.0 to 1.0
    agent_consensus_pct FLOAT NOT NULL,  -- 0-100% agents aligned
    disagreement_level FLOAT,  -- 0-1, how much agents disagree
    
    -- Agent counts
    long_count INT DEFAULT 0,
    short_count INT DEFAULT 0,
    neutral_count INT DEFAULT 0,
    
    -- Risk decision
    risk_approved BOOLEAN DEFAULT TRUE,
    risk_reason TEXT,
    
    -- Metadata
    payload JSONB,  -- Full voting breakdown
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_symbol (symbol),
    INDEX idx_direction (direction),
    INDEX idx_consensus (agent_consensus_pct),
    INDEX idx_created_at (created_at),
    INDEX idx_symbol_time (symbol, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. AGENT LEARNING UPDATES
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_learning_updates (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    decision_id VARCHAR(256),
    symbol VARCHAR(32) NOT NULL,
    
    -- Trade outcome
    pnl_usd FLOAT NOT NULL,
    pnl_pct FLOAT NOT NULL,
    regime VARCHAR(32),  -- trend, chop, volatile, balanced
    
    -- Agent performance (stored as JSON)
    agent_updates JSONB,  -- {agent_id: {win_rate, weight, adjustment}}
    
    -- Signal quality
    signal_confidence FLOAT,
    hold_duration_hours FLOAT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_decision_id (decision_id),
    INDEX idx_symbol (symbol),
    INDEX idx_regime (regime),
    INDEX idx_created_at (created_at),
    FOREIGN KEY (decision_id) REFERENCES multi_agent_decisions(decision_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AGENT PERFORMANCE SNAPSHOTS (Periodic aggregation)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_performance_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    agent_type VARCHAR(32) NOT NULL,  -- orderflow, momentum, reversal, regime, risk
    
    -- Performance metrics
    total_signals INT DEFAULT 0,
    winning_signals INT DEFAULT 0,
    losing_signals INT DEFAULT 0,
    win_rate_pct FLOAT DEFAULT 50.0,
    
    -- Risk-adjusted returns
    sharpe_ratio FLOAT,
    sortino_ratio FLOAT,
    calmar_ratio FLOAT,
    
    -- Regime-specific
    performance_by_regime JSONB,  -- {trend: {total: 10, wins: 7, avg_pnl: 150}}
    
    -- Adaptive weights
    current_weight FLOAT DEFAULT 1.0,
    adaptive_adjustment FLOAT DEFAULT 0.0,
    
    -- Timestamp
    snapshot_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_symbol (symbol),
    INDEX idx_agent_type (agent_type),
    INDEX idx_win_rate (win_rate_pct),
    INDEX idx_snapshot_date (snapshot_date),
    UNIQUE KEY unique_agent_date (symbol, agent_type, snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MULTI-AGENT AUDIT TRAIL
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS multi_agent_audit (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    decision_id VARCHAR(256),
    symbol VARCHAR(32),
    
    event_type VARCHAR(64),  -- vote_conducted, agent_updated, risk_block, learning_update
    event_detail TEXT,
    
    -- Which agents involved
    agents JSONB,  -- List of agent IDs/types involved
    
    -- Result
    outcome VARCHAR(32),  -- success, partial, blocked, error
    reason TEXT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_decision_id (decision_id),
    INDEX idx_event_type (event_type),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. AGENT SIGNAL HISTORY (for deep analysis)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_signal_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    decision_id VARCHAR(256),
    symbol VARCHAR(32) NOT NULL,
    
    agent_id VARCHAR(128) NOT NULL,
    agent_type VARCHAR(32) NOT NULL,
    
    -- Signal details
    direction VARCHAR(16),  -- long, short, neutral, wait
    confidence FLOAT,
    score FLOAT,
    reasoning TEXT,
    
    -- Performance
    hit_rate_pct FLOAT,
    last_signal_sharpe FLOAT,
    
    -- Metadata
    metadata JSONB,
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_decision_id (decision_id),
    INDEX idx_symbol (symbol),
    INDEX idx_agent_type (agent_type),
    INDEX idx_direction (direction),
    INDEX idx_created_at (created_at),
    INDEX idx_agent_symbol (agent_type, symbol, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. REGIME CLASSIFICATION HISTORY
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS regime_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    
    regime VARCHAR(32),  -- trend, chop, volatile, balanced
    regime_confidence FLOAT,
    
    -- Market metrics at time of classification
    adx FLOAT,
    chop_index FLOAT,
    volatility FLOAT,
    trend_strength FLOAT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_symbol (symbol),
    INDEX idx_regime (regime),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. CONSENSUS METRICS (for dashboard)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consensus_metrics (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    
    -- Consensus strength
    avg_consensus_pct FLOAT,
    avg_disagreement FLOAT,
    
    -- Direction frequency (24h rolling)
    long_pct_24h FLOAT,
    short_pct_24h FLOAT,
    neutral_pct_24h FLOAT,
    
    -- Signal quality
    avg_confidence FLOAT,
    decision_count_24h INT,
    
    metric_hour TIMESTAMP,  -- Which hour this metric represents
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes
    INDEX idx_symbol (symbol),
    INDEX idx_metric_hour (metric_hour),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. VIEWS FOR EASY QUERYING
-- ─────────────────────────────────────────────────────────────────────────────

-- Agent performance summary (last 7 days)
CREATE OR REPLACE VIEW v_agent_performance_7d AS
SELECT 
    agent_type,
    COUNT(*) as total_signals,
    SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
    ROUND(SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate_pct,
    ROUND(AVG(pnl_usd), 2) as avg_pnl_usd,
    ROUND(SUM(pnl_usd), 2) as total_pnl_usd
FROM (
    SELECT 
        ash.agent_type,
        alu.pnl_usd
    FROM agent_signal_history ash
    LEFT JOIN agent_learning_updates alu ON ash.decision_id = alu.decision_id
    WHERE ash.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
) t
GROUP BY agent_type
ORDER BY win_rate_pct DESC;


-- Decision quality by regime
CREATE OR REPLACE VIEW v_decision_quality_by_regime AS
SELECT 
    alu.regime,
    COUNT(DISTINCT alu.decision_id) as total_decisions,
    ROUND(AVG(mad.meta_confidence), 3) as avg_confidence,
    ROUND(AVG(mad.agent_consensus_pct), 1) as avg_consensus,
    ROUND(SUM(CASE WHEN alu.pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate_pct,
    ROUND(AVG(alu.pnl_usd), 2) as avg_pnl_usd,
    SUM(CASE WHEN alu.pnl_usd > 0 THEN alu.pnl_usd ELSE 0 END) as gross_wins,
    SUM(CASE WHEN alu.pnl_usd < 0 THEN ABS(alu.pnl_usd) ELSE 0 END) as gross_losses
FROM agent_learning_updates alu
LEFT JOIN multi_agent_decisions mad ON alu.decision_id = mad.decision_id
WHERE alu.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY alu.regime
ORDER BY win_rate_pct DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. STORED PROCEDURES FOR MAINTENANCE
-- ─────────────────────────────────────────────────────────────────────────────

DELIMITER //

-- Generate daily performance snapshot
CREATE PROCEDURE sp_generate_daily_snapshot()
BEGIN
    INSERT INTO agent_performance_snapshots (
        symbol, agent_type, total_signals, winning_signals, losing_signals, 
        win_rate_pct, performance_by_regime, snapshot_date
    )
    SELECT 
        'BTCUSD',  -- Hardcoded for now, would be parameterized
        ash.agent_type,
        COUNT(*) as total_signals,
        SUM(CASE WHEN alu.pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN alu.pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(CASE WHEN alu.pnl_usd > 0 THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
        JSON_OBJECT(
            'trend', JSON_OBJECT(
                'total', COUNT(CASE WHEN alu.regime = 'trend' THEN 1 END),
                'wins', SUM(CASE WHEN alu.regime = 'trend' AND alu.pnl_usd > 0 THEN 1 ELSE 0 END)
            ),
            'chop', JSON_OBJECT(
                'total', COUNT(CASE WHEN alu.regime = 'chop' THEN 1 END),
                'wins', SUM(CASE WHEN alu.regime = 'chop' AND alu.pnl_usd > 0 THEN 1 ELSE 0 END)
            )
        ) as breakdown,
        CURDATE()
    FROM agent_signal_history ash
    LEFT JOIN agent_learning_updates alu ON ash.decision_id = alu.decision_id
    WHERE ash.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
    AND ash.created_at < NOW()
    GROUP BY ash.agent_type
    ON DUPLICATE KEY UPDATE
        total_signals = VALUES(total_signals),
        winning_signals = VALUES(winning_signals),
        losing_signals = VALUES(losing_signals),
        win_rate_pct = VALUES(win_rate_pct);
END //

-- Cleanup old data (keep 90 days)
CREATE PROCEDURE sp_cleanup_old_data()
BEGIN
    DELETE FROM agent_signal_history WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
    DELETE FROM agent_learning_updates WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
    DELETE FROM multi_agent_audit WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
END //

DELIMITER ;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. INITIAL DATA & SETUP
-- ─────────────────────────────────────────────────────────────────────────────

-- Schedule daily snapshots (MySQL event)
CREATE EVENT IF NOT EXISTS evt_daily_agent_snapshot
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP
DO CALL sp_generate_daily_snapshot();

-- Schedule cleanup (keep 90 days)
CREATE EVENT IF NOT EXISTS evt_cleanup_old_data
ON SCHEDULE EVERY 1 WEEK
STARTS CURRENT_TIMESTAMP
DO CALL sp_cleanup_old_data();


-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY TABLES CREATED
-- ═══════════════════════════════════════════════════════════════════════════

SHOW TABLES LIKE 'multi_agent%';
SHOW TABLES LIKE 'agent_%';
SHOW TABLES LIKE 'regime%';
SHOW TABLES LIKE 'consensus%';
