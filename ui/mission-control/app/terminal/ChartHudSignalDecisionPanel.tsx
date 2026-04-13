"use client";

import type { ChartHudSignalDecisionPanelProps } from "./chartHudTypes";

export default function ChartHudSignalDecisionPanel({
  signalDisplayMode,
  marketSignal,
  perceptionMotionClass,
  perceptionSetupReady,
  perceptionCoreLabel,
  perceptionReasonCode,
  showReasonLegend,
  onToggleShowReasonLegend,
  perceptionReasonLegend,
  perceptionTargetLabel,
  perceptionActionLabel,
  signalConfidenceDrift,
  marketDecision,
  showConfluenceTune,
  onToggleShowConfluenceTune,
  showDecisionSecondary,
  onToggleShowDecisionSecondary,
  confluenceWeights,
  onChangeConfluenceWeight,
  decisionSecondaryRef,
  entryTimingV3,
  tradeManagementV3,
  intelligentExitV3,
  trailingV3,
  confidencePillTone,
  autoExecutionMode,
  onSetAutoExecutionMode,
  autoExecutionKillSwitch,
  onToggleAutoExecutionKillSwitch,
  autoSessionGuardEnabled,
  onToggleAutoSessionGuardEnabled,
  autoSessionStartHour,
  onSetAutoSessionStartHour,
  autoSessionEndHour,
  onSetAutoSessionEndHour,
  autoSymbolLossCapUsd,
  onSetAutoSymbolLossCapUsd,
  autoSymbolLoss,
  onResetAutoSymbolLoss,
  autoExecutionGate,
  autoMetaPass,
  autoRiskEngine,
  openTradesCount,
  exposureRatio,
  dailyDrawdownPct,
  autoSessionGuard,
  filteredAutoExecutionAuditTrail,
  autoExecutionAuditTrailLength,
  autoExecutionAuditStateFilter,
  onSetAutoExecutionAuditStateFilter,
  autoExecutionAuditReasonSearch,
  onSetAutoExecutionAuditReasonSearch,
  onExportAutoExecutionAuditJson,
  onExportAutoExecutionAuditCsv,
  onClearAutoExecutionAuditTrail,
  formatClock,
  selfLearningV4Enabled,
  onToggleSelfLearningV4Enabled,
  selfLearningAutoAdaptEnabled,
  onToggleSelfLearningAutoAdaptEnabled,
  selfLearningDriftV4,
  selfLearningV4DriftLabel,
  filteredSelfLearningJournalV4Trail,
  selfLearningJournalV4TrailLength,
  onExportSelfLearningJournalV4Json,
  onExportSelfLearningJournalV4Csv,
  onClearSelfLearningJournalV4Trail,
  selfLearningJournalV4RegimeFilter,
  onSetSelfLearningJournalV4RegimeFilter,
  selfLearningJournalV4ScenarioFilter,
  onSetSelfLearningJournalV4ScenarioFilter,
  selfLearningV4Active,
  selfLearningStorageTone,
  selfLearningStorageLabel,
  selfLearningV4PersistenceStatus,
  selfLearningCurrentScopeCount,
  selfLearningRegimeV4,
  selfLearningV4WeightsLabel,
  selfLearningV4ModelLabel,
  selfLearningProfile,
  selfLearningModelUpdatedAt,
  selfLearningDriftAutoDemotedAt,
  selfLearningAdaptiveWeights,
  brainAttributionHeadline,
  brainAttributionPills,
  brainLearningRatePills,
  institutionalHealing,
  institutionalSnapshot,
  executionWarfare,
  brokerAwareScheduler,
  stabilityEngine,
  strategyEvolution,
  executionAdaptMode,
  onSetExecutionAdaptMode,
  pendingExecutionAdaptation,
  onApplyPendingExecutionAdaptation,
}: ChartHudSignalDecisionPanelProps) {
  if (signalDisplayMode === "classic") {
    return null;
  }

  return (
    <div className={`chart-signal-card chart-signal-card-${marketSignal.dominantDirection}`}>
      <div className={`chart-perception-layer direction-${marketSignal.dominantDirection} motion-${perceptionMotionClass} ${perceptionSetupReady ? "setup-ready" : ""}`}>
        <div className="chart-perception-line header">
          <span>LONG {marketSignal.directionalLongPct}% / SHORT {marketSignal.directionalShortPct}%</span>
          <span>CONF {marketSignal.directionalConfidenceLabel}</span>
        </div>
        <div className="chart-perception-line core">{perceptionCoreLabel}</div>
        {perceptionReasonCode ? (
          <div className={`chart-perception-reason-wrap ${showReasonLegend ? "is-open" : ""}`}>
            <div className="chart-perception-line reason">{perceptionReasonCode}</div>
            <button
              type="button"
              className="chart-perception-legend-trigger"
              aria-label="Reason code legend"
              aria-expanded={showReasonLegend}
              onClick={onToggleShowReasonLegend}
            >
              ⓘ
            </button>
            <div className="chart-perception-legend" role="note">
              <span className="chart-perception-legend-line">{perceptionReasonLegend?.line1 || "signal context"}</span>
              {perceptionReasonLegend?.line2 ? <span className="chart-perception-legend-line sub">{perceptionReasonLegend.line2}</span> : null}
            </div>
          </div>
        ) : null}
        <div className="chart-perception-line target">{perceptionTargetLabel}</div>
        <div className="chart-perception-line action">{perceptionActionLabel}</div>
      </div>
      <div className="chart-signal-card-head">
        <span className="chart-signal-kicker">Signal Engine V2</span>
        <strong>{marketSignal.headline}</strong>
        <span className="chart-signal-directional-kpi">
          LONG {marketSignal.directionalLongPct}% / SHORT {marketSignal.directionalShortPct}% / CONF {marketSignal.directionalConfidenceLabel}
          <span className={`chart-signal-drift-badge ${signalConfidenceDrift.toLowerCase()}`}>
            <span className="chart-signal-drift-arrow" aria-hidden="true">{signalConfidenceDrift === "UP" ? "↑" : signalConfidenceDrift === "DOWN" ? "↓" : "→"}</span>
            <span>{signalConfidenceDrift}</span>
          </span>
        </span>
      </div>
      <div className="chart-signal-score-row">
        <span>Buy {marketSignal.buyPressurePct.toFixed(0)}%</span>
        <span>Sell {marketSignal.sellPressurePct.toFixed(0)}%</span>
        <span>{marketSignal.convictionLabel}</span>
      </div>
      <div className="chart-signal-tags">
        {marketSignal.signals.length === 0 ? (
          <span className="chart-signal-tag neutral">No dominant flow signal</span>
        ) : (
          marketSignal.signals.map((signal) => (
            <span
              key={`hud-signal-${signal.id}-${signal.direction}`}
              className={`chart-signal-tag ${signal.direction} ${signal.severity}`}
              title={signal.detail}
            >
              {signal.label}
            </span>
          ))
        )}
      </div>
      <div className={`chart-decision-card ${marketDecision.criticalConfirmed ? "mobile-critical-sticky" : ""}`}>
        <div className="chart-decision-card-head">
          <span className="chart-signal-kicker">Decision Engine V1</span>
          <strong>{marketDecision.scenarioLabel}</strong>
        </div>
        <div className="chart-signal-score-row">
          <span>Scenario {marketDecision.scenarioProbabilityPct}%</span>
          <span>Confidence {marketDecision.globalConfidencePct}%</span>
          <span>Confluence {marketDecision.confluenceScorePct}%</span>
          <span>{marketDecision.probableReversalZoneLabel}</span>
        </div>
        <div className="chart-learning-strip">
          <span>Learn {marketDecision.historicalLearning.scopeLabel} · n={marketDecision.historicalLearning.sampleSize} · WR {marketDecision.historicalLearning.winratePct.toFixed(0)}%</span>
        </div>
        <div className="chart-decision-tools">
          <button type="button" className={`chart-chip ${showConfluenceTune ? "active" : ""}`} onClick={onToggleShowConfluenceTune}>
            {showConfluenceTune ? `Hide Tune ${marketDecision.evidence.length}` : `Tune ${marketDecision.evidence.length}`}
          </button>
          <button type="button" className={`chart-chip chart-decision-details-toggle ${showDecisionSecondary ? "active" : ""}`} onClick={onToggleShowDecisionSecondary}>
            {showDecisionSecondary ? "Hide Details" : "Details"}
          </button>
        </div>
        {showConfluenceTune ? (
          <div className="chart-confluence-controls">
            {marketDecision.evidence.map((item) => (
              <label key={`weight-${item.id}`} className="chart-confluence-control">
                <span>{item.label} manual x{confluenceWeights[item.id].toFixed(2)} · learned x{marketDecision.historicalLearning.learnedWeights[item.id].toFixed(2)}</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.8}
                  step={0.05}
                  value={confluenceWeights[item.id]}
                  onChange={(event) => onChangeConfluenceWeight(item.id, Number(event.target.value || confluenceWeights[item.id]))}
                />
              </label>
            ))}
          </div>
        ) : null}
        <div ref={decisionSecondaryRef} className={`chart-decision-secondary ${showDecisionSecondary ? "open" : ""}`}>
          <div className="chart-evidence-grid">
            {marketDecision.evidence.map((item) => (
              <div key={`evidence-${item.id}`} className={`chart-evidence-item ${item.direction}`}>
                <span className="chart-evidence-label">{item.label}</span>
                <strong>{item.scorePct}%</strong>
                <em>{item.detail}</em>
              </div>
            ))}
          </div>
        </div>
        <div className={`chart-action-card chart-action-card-${marketDecision.biasDirection}`}>
          <div className="chart-action-card-head">
            <span className="chart-signal-kicker">Action Card</span>
            <strong>{marketDecision.actionTitle}</strong>
          </div>
          <div className="chart-action-card-body">{marketDecision.actionBody}</div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">Execution Brain V3</div>
            <div className="chart-execution-brain-v3-grid">
              <span className={`chart-action-pill chart-action-pill-status ${entryTimingV3.tone}`}>ENTRY {entryTimingV3.status}<span className={`chart-action-pill-conf ${confidencePillTone(entryTimingV3.confidence)}`}>{entryTimingV3.confidence.toFixed(2)}</span></span>
              <span className="chart-action-pill">{entryTimingV3.detail}</span>
              <span className={`chart-action-pill chart-action-pill-status ${tradeManagementV3.tone}`}>{tradeManagementV3.status}<span className={`chart-action-pill-conf ${confidencePillTone(tradeManagementV3.confidence)}`}>{tradeManagementV3.confidence.toFixed(2)}</span></span>
              <span className="chart-action-pill">{tradeManagementV3.detail}</span>
              <span className={`chart-action-pill chart-action-pill-status ${intelligentExitV3.tone}`}>{intelligentExitV3.status}<span className={`chart-action-pill-conf ${confidencePillTone(intelligentExitV3.confidence)}`}>{intelligentExitV3.confidence.toFixed(2)}</span></span>
              <span className="chart-action-pill">{intelligentExitV3.detail}</span>
              <span className={`chart-action-pill chart-action-pill-status ${trailingV3.tone}`}>TRAILING {trailingV3.status}</span>
              <span className="chart-action-pill">{trailingV3.detail}</span>
            </div>
          </div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">Explainable RL</div>
            <div className="chart-learning-strip">
              <span>{brainAttributionHeadline}</span>
            </div>
            <div className="chart-execution-brain-v3-grid">
              {brainAttributionPills.length > 0 ? brainAttributionPills.map((pill) => (
                <span key={`brain-attr-${pill}`} className="chart-action-pill">{pill}</span>
              )) : <span className="chart-action-pill">Attribution warming up</span>}
              {brainLearningRatePills.length > 0 ? brainLearningRatePills.map((pill) => (
                <span key={`brain-lr-${pill}`} className="chart-action-pill">{pill}</span>
              )) : <span className="chart-action-pill">LR adaptation pending</span>}
            </div>
          </div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">V7.5 + V8 Institutional</div>
            <div className="chart-learning-strip">
              <span>{institutionalHealing.causalMemoryLabel} · {institutionalSnapshot.memoryGraphLabel}</span>
            </div>
            <div className="chart-execution-brain-v3-grid">
              <span className={`chart-action-pill chart-action-pill-status ${institutionalHealing.executionEnabled ? institutionalHealing.drift === "STABLE" ? "good" : "warn" : "bad"}`}>HEAL {institutionalHealing.action}</span>
              <span className="chart-action-pill">Mode {institutionalHealing.mode.toUpperCase()} · Drift {institutionalHealing.drift}</span>
              <span className={`chart-action-pill chart-action-pill-status ${institutionalSnapshot.healthState === "strong" ? "good" : institutionalSnapshot.healthState === "guarded" ? "warn" : "bad"}`}>HEALTH {institutionalSnapshot.healthScorePct.toFixed(0)}%</span>
              <span className="chart-action-pill">Agent {institutionalSnapshot.selectedAgent}</span>
              <span className="chart-action-pill">Failure {institutionalHealing.dominantFailureSource}</span>
              <span className="chart-action-pill">Adapt {institutionalHealing.adaptSpeedPct.toFixed(0)}% · size x{institutionalHealing.riskMultiplier.toFixed(2)}</span>
              <span className="chart-action-pill">Exec {institutionalSnapshot.executionStyle} · x{institutionalSnapshot.sizeMultiplier.toFixed(2)}</span>
              <span className="chart-action-pill">Live {institutionalHealing.executionEnabled ? "ON" : "OFF"}</span>
              {institutionalSnapshot.capitalAllocationPills.length > 0 ? institutionalSnapshot.capitalAllocationPills.map((pill) => (
                <span key={`inst-cap-${pill}`} className="chart-action-pill">{pill}</span>
              )) : <span className="chart-action-pill">Capital allocation warming up</span>}
              {institutionalHealing.reasons.length > 0 ? institutionalHealing.reasons.map((reason) => (
                <span key={`heal-reason-${reason}`} className="chart-action-pill">{reason}</span>
              )) : null}
              {institutionalSnapshot.reasonPills.length > 0 ? institutionalSnapshot.reasonPills.map((pill) => (
                <span key={`inst-reason-${pill}`} className="chart-action-pill">{pill}</span>
              )) : null}
            </div>
          </div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">V8.5 Execution Warfare</div>
            <div className="chart-learning-strip">
              <span>{executionWarfare.adversarialState} · trap {executionWarfare.trapState} · guard {executionWarfare.guardAction}</span>
            </div>
            <div className="chart-execution-brain-v3-grid">
              <span className={`chart-action-pill chart-action-pill-status ${executionWarfare.guardAction === "BLOCK" ? "bad" : executionWarfare.mode === "AGGRESSIVE" ? "good" : executionWarfare.mode === "STEALTH" ? "warn" : "neutral"}`}>WAR {executionWarfare.mode}</span>
              <span className="chart-action-pill">Venue {executionWarfare.venue || "AUTO"}</span>
              <span className={`chart-action-pill chart-action-pill-status ${executionWarfare.executionScorePct >= 72 ? "good" : executionWarfare.executionScorePct >= 50 ? "warn" : "bad"}`}>Score {executionWarfare.executionScorePct.toFixed(0)}%</span>
              <span className="chart-action-pill">Slices {executionWarfare.slices} · {executionWarfare.sliceNotionalUsd.toFixed(0)} USD</span>
              <span className="chart-action-pill">Delay {executionWarfare.delayMs}ms · edge {executionWarfare.latencyEdgeMs >= 0 ? "+" : ""}{executionWarfare.latencyEdgeMs.toFixed(0)}ms</span>
              <span className="chart-action-pill">Hidden {executionWarfare.hiddenLiquidityPct.toFixed(0)}% · spoof {executionWarfare.spoofProbabilityPct.toFixed(0)}%</span>
              <span className="chart-action-pill">Sweep {executionWarfare.sweepRiskPct.toFixed(0)}% · {executionWarfare.adversarialState}</span>
              <span className="chart-action-pill">Trap {executionWarfare.trapState}</span>
              {executionWarfare.reasons.length > 0 ? executionWarfare.reasons.map((reason) => (
                <span key={`warfare-reason-${reason}`} className="chart-action-pill">{reason}</span>
              )) : <span className="chart-action-pill">warfare nominal</span>}
            </div>
          </div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">V8.5.1 Broker Scheduler</div>
            <div className="chart-learning-strip">
              <span>{brokerAwareScheduler.mode} · {brokerAwareScheduler.action} · {brokerAwareScheduler.activeChildState} · {brokerAwareScheduler.replaceStrategy}</span>
            </div>
            <div className="chart-execution-brain-v3-grid">
              <span className={`chart-action-pill chart-action-pill-status ${brokerAwareScheduler.action === "BLOCK" ? "bad" : brokerAwareScheduler.action === "CANCEL_REPLACE" || brokerAwareScheduler.action === "RESLICE" ? "warn" : "good"}`}>SCHED {brokerAwareScheduler.scheduleScorePct.toFixed(0)}%</span>
              <span className="chart-action-pill">Venue {brokerAwareScheduler.venue || "AUTO"} · {brokerAwareScheduler.provider || "unknown"}</span>
              <span className="chart-action-pill">Children {brokerAwareScheduler.childCount} · state {brokerAwareScheduler.activeChildState}</span>
              <span className="chart-action-pill">Fill {brokerAwareScheduler.averageFillRatioPct.toFixed(0)}% · partial {brokerAwareScheduler.partialFillRatioPct.toFixed(0)}%</span>
              <span className="chart-action-pill">Replace x{brokerAwareScheduler.replaceBudget} · reslice +{brokerAwareScheduler.resliceCount}</span>
              <span className="chart-action-pill">Caps modify {brokerAwareScheduler.supportsModify ? "ON" : "OFF"} · cancel/replace {brokerAwareScheduler.supportsCancelReplace ? "ON" : "OFF"}</span>
              {brokerAwareScheduler.reasons.length > 0 ? brokerAwareScheduler.reasons.map((reason) => (
                <span key={`scheduler-reason-${reason}`} className="chart-action-pill">{reason}</span>
              )) : <span className="chart-action-pill">scheduler nominal</span>}
            </div>
          </div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">Stability Engine</div>
            <div className="chart-learning-strip">
              <span>{stabilityEngine.mode.toUpperCase()} · {stabilityEngine.driftWatchdog} · {stabilityEngine.comparatorLabel}</span>
            </div>
            <div className="chart-execution-brain-v3-grid">
              <span className={`chart-action-pill chart-action-pill-status ${stabilityEngine.shouldBlockExecution ? "bad" : stabilityEngine.mode === "live" ? "good" : "warn"}`}>STAB {stabilityEngine.monitorScorePct.toFixed(0)}%</span>
              <span className="chart-action-pill">Fallback {stabilityEngine.shadowFallbackRatePct.toFixed(2)}%</span>
              <span className="chart-action-pill">Net timeout {stabilityEngine.timeoutRatePct.toFixed(1)}% · dns {stabilityEngine.dnsTransientRatePct.toFixed(1)}%</span>
              <span className="chart-action-pill">Degraded {stabilityEngine.degradedUsageRatioPct.toFixed(1)}% · kill {stabilityEngine.externalKillSwitchActive ? "ON" : "OFF"}</span>
              {stabilityEngine.alerts.length > 0 ? stabilityEngine.alerts.map((alert) => (
                <span key={`stability-alert-${alert}`} className="chart-action-pill">{alert}</span>
              )) : <span className="chart-action-pill">stability nominal</span>}
              {stabilityEngine.reasons.length > 0 ? stabilityEngine.reasons.map((reason) => (
                <span key={`stability-reason-${reason}`} className="chart-action-pill">{reason}</span>
              )) : null}
            </div>
          </div>
          <div className="chart-execution-brain-v3">
            <div className="chart-signal-kicker">V9 Strategy Evolution</div>
            <div className="chart-learning-strip">
              <span>{strategyEvolution.capitalMode} · {strategyEvolution.evolutionMode} · pipeline {strategyEvolution.preservePipeline ? "preserved" : "mutating"}</span>
            </div>
            <div className="chart-execution-brain-v3-grid">
              <span className={`chart-action-pill chart-action-pill-status ${strategyEvolution.capitalMode === "growth" ? "good" : strategyEvolution.capitalMode === "balanced" ? "neutral" : strategyEvolution.capitalMode === "halt" ? "bad" : "warn"}`}>V9 {strategyEvolution.capitalMode}</span>
              <span className="chart-action-pill">Strategy {strategyEvolution.selectedStrategy}</span>
              <span className="chart-action-pill">Shift {strategyEvolution.allocationShiftPct >= 0 ? "+" : ""}{strategyEvolution.allocationShiftPct.toFixed(1)}%</span>
              <span className="chart-action-pill">Learning {strategyEvolution.learningBiasPct.toFixed(0)}%</span>
              {strategyEvolution.allocationPills.length > 0 ? strategyEvolution.allocationPills.map((pill) => (
                <span key={`v9-alloc-${pill}`} className="chart-action-pill">{pill}</span>
              )) : <span className="chart-action-pill">allocation pending</span>}
              {strategyEvolution.reasons.length > 0 ? strategyEvolution.reasons.map((reason) => (
                <span key={`v9-reason-${reason}`} className="chart-action-pill">{reason}</span>
              )) : null}
            </div>
          </div>
          <div className="chart-auto-exec-panel">
            <div className="chart-signal-kicker">Execution Modules</div>
            <div className="chart-auto-exec-mode-row">
              {(["assisted", "semi-auto", "full-auto"] as const).map((mode) => (
                <button key={`auto-exec-${mode}`} type="button" className={`chart-chip ${autoExecutionMode === mode ? "active" : ""}`} onClick={() => onSetAutoExecutionMode(mode)}>
                  {mode === "assisted" ? "Human" : mode === "semi-auto" ? "Hybrid" : "AI"}
                </button>
              ))}
              <button type="button" className={`chart-chip ${autoExecutionKillSwitch ? "active" : ""}`} onClick={onToggleAutoExecutionKillSwitch}>
                Kill Switch {autoExecutionKillSwitch ? "ON" : "OFF"}
              </button>
              <button type="button" className={`chart-chip ${autoSessionGuardEnabled ? "active" : ""}`} onClick={onToggleAutoSessionGuardEnabled}>
                Session Guard {autoSessionGuardEnabled ? "ON" : "OFF"}
              </button>
            </div>
            <div className="chart-auto-exec-controls-grid">
              <label className="chart-confluence-control chart-auto-exec-control-field">
                <span>Session start (hour)</span>
                <input type="number" min={0} max={23} step={1} value={autoSessionStartHour} onChange={(event) => onSetAutoSessionStartHour(Number(event.target.value || 0))} />
              </label>
              <label className="chart-confluence-control chart-auto-exec-control-field">
                <span>Session end (hour)</span>
                <input type="number" min={0} max={23} step={1} value={autoSessionEndHour} onChange={(event) => onSetAutoSessionEndHour(Number(event.target.value || 0))} />
              </label>
              <label className="chart-confluence-control chart-auto-exec-control-field">
                <span>Symbol loss cap (USD)</span>
                <input type="number" min={50} step={25} value={autoSymbolLossCapUsd} onChange={(event) => onSetAutoSymbolLossCapUsd(Number(event.target.value || 0))} />
              </label>
              <button type="button" className="chart-chip" onClick={onResetAutoSymbolLoss}>
                Reset {autoSymbolLoss.normalizedSymbol}
              </button>
            </div>
            <div className="chart-auto-exec-status-grid">
              <span className={`chart-action-pill chart-action-pill-status ${autoExecutionGate.autoState === "READY" ? "good" : autoExecutionGate.autoState === "KILLED" ? "bad" : "warn"}`}>AUTO {autoExecutionGate.autoState}</span>
              <span className="chart-action-pill">META {autoMetaPass ? "PASS" : "BLOCK"}</span>
              <span className={`chart-action-pill ${autoRiskEngine.hardPass ? "chart-action-pill-status good" : "chart-action-pill-status bad"}`}>RISK {autoExecutionGate.riskLabel}</span>
              <span className="chart-action-pill">SIZE {autoExecutionGate.sizeLabel}</span>
              <span className="chart-action-pill">OPEN {openTradesCount}/{autoRiskEngine.maxOpenTrades}</span>
              <span className="chart-action-pill">EXPO {(exposureRatio * 100).toFixed(1)}%/{autoRiskEngine.maxExposurePct}%</span>
              <span className="chart-action-pill">DD {dailyDrawdownPct.toFixed(1)}%/{autoRiskEngine.maxDailyLossPct}%</span>
              <span className="chart-action-pill">RULE {autoExecutionGate.ruleLabel}</span>
              <span className={`chart-action-pill ${autoSessionGuard.pass ? "chart-action-pill-status good" : "chart-action-pill-status warn"}`}>SESS {autoSessionGuard.pass ? "ON" : "OFF"} {autoSessionGuard.label}</span>
              <span className={`chart-action-pill ${autoSymbolLoss.pass ? "chart-action-pill-status good" : "chart-action-pill-status bad"}`}>SYM LOSS {autoSymbolLoss.cumulativeLossUsd.toFixed(0)}/{autoSymbolLossCapUsd.toFixed(0)}</span>
            </div>
            <div className="chart-auto-exec-audit-toolbar">
              <span className="chart-action-pill">Audit {filteredAutoExecutionAuditTrail.length}/{autoExecutionAuditTrailLength}</span>
              {(["all", "READY", "BLOCKED", "KILLED"] as const).map((stateKey) => (
                <button key={`auto-audit-state-${stateKey}`} type="button" className={`chart-chip ${autoExecutionAuditStateFilter === stateKey ? "active" : ""}`} onClick={() => onSetAutoExecutionAuditStateFilter(stateKey)}>
                  {stateKey}
                </button>
              ))}
              <input type="text" className="chart-auto-exec-reason-search" placeholder="reason search" value={autoExecutionAuditReasonSearch} onChange={(event) => onSetAutoExecutionAuditReasonSearch(event.target.value)} />
              <button type="button" className="chart-chip" onClick={onExportAutoExecutionAuditJson}>Export JSON</button>
              <button type="button" className="chart-chip" onClick={onExportAutoExecutionAuditCsv}>Export CSV</button>
              <button type="button" className="chart-chip" onClick={onClearAutoExecutionAuditTrail}>Clear</button>
            </div>
            <div className="chart-auto-exec-audit-list">
              {filteredAutoExecutionAuditTrail.slice(0, 8).map((event) => (
                <div key={event.id} className="chart-auto-exec-audit-row">
                  <span>{formatClock(event.timestampIso)}</span>
                  <span>{event.gateState}</span>
                  <span>{event.mode}</span>
                  <span>{event.sizeUsd.toFixed(0)} USD</span>
                  <span>{event.reasons.length > 0 ? event.reasons.join("+") : "ok"}</span>
                </div>
              ))}
              {filteredAutoExecutionAuditTrail.length === 0 ? <div className="chart-auto-exec-audit-empty">No audit row for current filter.</div> : null}
            </div>
          </div>
          <div className="chart-learning-v4-panel">
            <div className="chart-signal-kicker">Self Learning V4</div>
            <div className="chart-learning-v4-controls">
              <button type="button" className={`chart-chip ${selfLearningV4Enabled ? "active" : ""}`} onClick={onToggleSelfLearningV4Enabled}>
                Learning {selfLearningV4Enabled ? "ON" : "OFF"}
              </button>
              <button type="button" className={`chart-chip ${selfLearningAutoAdaptEnabled ? "active" : ""}`} onClick={onToggleSelfLearningAutoAdaptEnabled}>
                Weights {selfLearningAutoAdaptEnabled ? "Auto" : "Manual"}
              </button>
            </div>
            <div className="chart-learning-v4-toolbar">
              <span className={`chart-action-pill chart-action-pill-status ${selfLearningDriftV4.shouldDemote ? "bad" : selfLearningDriftV4.enoughSamples ? "good" : "warn"}`}>Drift {selfLearningV4DriftLabel}</span>
              <span className="chart-action-pill">Journal {filteredSelfLearningJournalV4Trail.length}/{selfLearningJournalV4TrailLength}</span>
              <button type="button" className="chart-chip" onClick={onExportSelfLearningJournalV4Json}>Export V4 JSON</button>
              <button type="button" className="chart-chip" onClick={onExportSelfLearningJournalV4Csv}>Export V4 CSV</button>
              <button type="button" className="chart-chip" onClick={onClearSelfLearningJournalV4Trail}>Clear</button>
            </div>
            <div className="chart-learning-v4-filters">
              {(["all", "trend", "chop", "volatile"] as const).map((regime) => (
                <button key={`sl-v4-regime-${regime}`} type="button" className={`chart-chip ${selfLearningJournalV4RegimeFilter === regime ? "active" : ""}`} onClick={() => onSetSelfLearningJournalV4RegimeFilter(regime)}>
                  R:{regime}
                </button>
              ))}
              {(["all", "reversal", "continuation", "balance"] as const).map((scenario) => (
                <button key={`sl-v4-scenario-${scenario}`} type="button" className={`chart-chip ${selfLearningJournalV4ScenarioFilter === scenario ? "active" : ""}`} onClick={() => onSetSelfLearningJournalV4ScenarioFilter(scenario)}>
                  S:{scenario}
                </button>
              ))}
            </div>
            <div className="chart-learning-v4-grid">
              <span className={`chart-action-pill ${selfLearningV4Active ? "chart-action-pill-status good" : "chart-action-pill-status warn"}`}>Learning {selfLearningV4Active ? "ACTIVE" : "WARMUP"}</span>
              <span className={`chart-action-pill chart-action-pill-status ${selfLearningStorageTone}`}>Persist {selfLearningStorageLabel}</span>
              <span className="chart-action-pill">Scopes {selfLearningV4PersistenceStatus.scopeCount} · Active {selfLearningCurrentScopeCount}</span>
              <span className="chart-action-pill">Load {selfLearningV4PersistenceStatus.stateLoadedAt ? formatClock(selfLearningV4PersistenceStatus.stateLoadedAt) : "--"}</span>
              <span className="chart-action-pill">Save {selfLearningV4PersistenceStatus.stateSavedAt ? formatClock(selfLearningV4PersistenceStatus.stateSavedAt) : "--"}</span>
              <span className="chart-action-pill">Scan {selfLearningV4PersistenceStatus.scopesLoadedAt ? formatClock(selfLearningV4PersistenceStatus.scopesLoadedAt) : "--"}</span>
              <span className="chart-action-pill">Status {selfLearningV4PersistenceStatus.message}</span>
              <span className="chart-action-pill">Regime {selfLearningRegimeV4.toUpperCase()}</span>
              <span className="chart-action-pill">Weights {selfLearningV4WeightsLabel}</span>
              <span className="chart-action-pill">Model {selfLearningV4ModelLabel}</span>
              <span className="chart-action-pill">n {selfLearningProfile.sampleSize} · WR {selfLearningProfile.winratePct.toFixed(0)}%</span>
              <span className="chart-action-pill">Upd {selfLearningModelUpdatedAt ? formatClock(selfLearningModelUpdatedAt) : "--"}</span>
              <span className="chart-action-pill">WR {selfLearningDriftV4.longWinratePct.toFixed(0)}→{selfLearningDriftV4.shortWinratePct.toFixed(0)} (Δ{selfLearningDriftV4.winrateDropPct.toFixed(0)}%)</span>
              <span className="chart-action-pill">Brier {(selfLearningDriftV4.longBrier ?? 0).toFixed(3)}→{(selfLearningDriftV4.shortBrier ?? 0).toFixed(3)} (Δ{selfLearningDriftV4.brierRise.toFixed(3)})</span>
              <span className="chart-action-pill">Demoted {selfLearningDriftAutoDemotedAt ? formatClock(selfLearningDriftAutoDemotedAt) : "--"}</span>
              <span className="chart-action-pill">DOM x{selfLearningAdaptiveWeights.dom.toFixed(2)} · FP x{selfLearningAdaptiveWeights.footprint.toFixed(2)}</span>
              <span className="chart-action-pill">LIQ x{selfLearningAdaptiveWeights.liquidity.toFixed(2)} · PX x{selfLearningAdaptiveWeights["price-action"].toFixed(2)}</span>
            </div>
            <div className="chart-learning-v4-journal-list">
              {filteredSelfLearningJournalV4Trail.slice(0, 6).map((event) => (
                <div key={event.id} className="chart-learning-v4-journal-row">
                  <span>{formatClock(event.timestampIso)}</span>
                  <span>{event.regime}</span>
                  <span>{event.scenario}</span>
                  <span>{event.outcome}</span>
                  <span>{event.pnl >= 0 ? "+" : ""}{event.pnl.toFixed(0)} USD</span>
                </div>
              ))}
              {filteredSelfLearningJournalV4Trail.length === 0 ? <div className="chart-auto-exec-audit-empty">No V4 journal row for current filter.</div> : null}
            </div>
          </div>
          <div className="chart-adapt-mode-row">
            {(["auto", "confirm", "manual"] as const).map((mode) => (
              <button key={`adapt-${mode}`} type="button" className={`chart-chip ${executionAdaptMode === mode ? "active" : ""}`} onClick={() => onSetExecutionAdaptMode(mode)}>
                {mode === "auto" ? "Auto adapt" : mode === "confirm" ? "Confirm adapt" : "Manual adapt"}
              </button>
            ))}
          </div>
          {pendingExecutionAdaptation ? (
            <div className="chart-pending-adaptation">
              <span>Pending adapt: snap {pendingExecutionAdaptation.plan.snapPriority} / preset {pendingExecutionAdaptation.plan.preset} / guard {pendingExecutionAdaptation.plan.guardEnabled ? "on" : "off"}</span>
              <button type="button" className="chart-chip" onClick={onApplyPendingExecutionAdaptation}>
                Apply Adaptation
              </button>
            </div>
          ) : null}
        </div>
        {marketDecision.criticalConfirmed ? <div className="chart-decision-confirmed">Critical confirmation: 2 sources aligned</div> : null}
      </div>
    </div>
  );
}