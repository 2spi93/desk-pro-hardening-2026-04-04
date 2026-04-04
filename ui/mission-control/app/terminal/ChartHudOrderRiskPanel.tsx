"use client";

import type { ChartHudOrderRiskPanelProps } from "./chartHudTypes";

export default function ChartHudOrderRiskPanel({
  chartOrderTicket,
  onApplyChartOrderPreset,
  onToggleChartOrderOco,
  chartSnapEnabled,
  onToggleChartSnapEnabled,
  chartSnapPriority,
  onSetChartSnapPriority,
  chartRiskUsd,
  chartRewardUsd,
  chartRiskReward,
  chartMaxLossUsd,
  onSetChartMaxLossUsd,
  chartTargetGainUsd,
  onSetChartTargetGainUsd,
  chartRiskGuardEnabled,
  onToggleChartRiskGuardEnabled,
  uiMode,
  onApplySafeRiskPreset,
  onApplyBalancedRiskPreset,
  onApplyDeskRiskPreset,
  chartRiskLossExceeded,
  chartRiskTargetMiss,
  chartRiskTargetRr,
  chartPriceStep,
  chartPriceDigits,
  chartSnapEnabledLabel,
  chartSnapState,
  chartOrderTicketEntryLabel,
  chartOrderTicketSlLabel,
  chartOrderTicketTpLabel,
  chartEffectiveSendMode,
  chartHudConfirmArmed,
  onToggleChartHudConfirmArmed,
  onSubmitChartOrder,
  mergedChartSendHistory,
  formatClock,
}: ChartHudOrderRiskPanelProps) {
  return (
    <>
      <div className="chart-order-preset-row">
        {(["scalp", "swing", "low-risk"] as const).map((presetKey) => (
          <button key={presetKey} type="button" className={`chart-chip${chartOrderTicket.preset === presetKey ? " active" : ""}`} onClick={() => onApplyChartOrderPreset(presetKey)}>
            {presetKey === "low-risk" ? "LowRisk" : presetKey}
          </button>
        ))}
      </div>
      <div className="chart-order-mini-row">
        <button type="button" className={`chart-chip ${chartOrderTicket.side === "buy" ? "chart-buy-btn" : ""}`} onClick={() => onApplyChartOrderPreset(chartOrderTicket.preset, "buy")}>Buy</button>
        <button type="button" className={`chart-chip ${chartOrderTicket.side === "sell" ? "chart-sell-btn" : ""}`} onClick={() => onApplyChartOrderPreset(chartOrderTicket.preset, "sell")}>Sell</button>
        <button type="button" className={`chart-chip ${chartOrderTicket.oco ? "active" : ""}`} onClick={onToggleChartOrderOco}>OCO</button>
        <button type="button" className={`chart-chip ${chartSnapEnabled ? "active" : ""}`} onClick={onToggleChartSnapEnabled}>{chartSnapEnabled ? "Snap On" : "Snap Off"}</button>
      </div>
      <div className="chart-order-mini-row">
        {(["execution", "vwap", "liquidity"] as const).map((priority) => (
          <button key={priority} type="button" className={`chart-chip ${chartSnapPriority === priority ? "active" : ""}`} onClick={() => onSetChartSnapPriority(priority)}>
            {priority === "execution" ? "Exec" : priority === "vwap" ? "VWAP" : "Liquidity"}
          </button>
        ))}
      </div>
      <div className="chart-order-risk-row">
        <span>Loss {chartRiskUsd.toFixed(2)}$</span>
        <span>Gain {chartRewardUsd.toFixed(2)}$</span>
        <span>RR {chartRiskReward.toFixed(2)}</span>
      </div>
      <div className="chart-order-risk-row chart-order-guard-row">
        <label className="chart-order-guard-field">
          <span>Perte max</span>
          <input type="number" min={1} step={10} value={chartMaxLossUsd} onChange={(event) => onSetChartMaxLossUsd(Math.max(1, Number(event.target.value || 0)))} className="chart-order-risk-input" />
        </label>
        <label className="chart-order-guard-field">
          <span>Gain cible</span>
          <input type="number" min={1} step={10} value={chartTargetGainUsd} onChange={(event) => onSetChartTargetGainUsd(Math.max(1, Number(event.target.value || 0)))} className="chart-order-risk-input" />
        </label>
      </div>
      <div className="chart-order-mini-row chart-order-guard-presets">
        <button type="button" className={`chart-chip ${chartRiskGuardEnabled ? "active" : ""}`} onClick={onToggleChartRiskGuardEnabled}>
          Guard {chartRiskGuardEnabled ? "On" : "Off"}
        </button>
        {uiMode === "novice" ? (
          <>
            <button type="button" className="chart-chip" onClick={onApplySafeRiskPreset}>Safe</button>
            <button type="button" className="chart-chip" onClick={onApplyBalancedRiskPreset}>Balanced</button>
          </>
        ) : (
          <button type="button" className="chart-chip" onClick={onApplyDeskRiskPreset}>Desk</button>
        )}
        <span className={`chart-order-guard-status ${chartRiskLossExceeded ? "bad" : chartRiskTargetMiss ? "warn" : "ok"}`}>
          {chartRiskLossExceeded ? "loss-limit exceeded" : chartRiskTargetMiss ? "target gain below objective" : "risk profile aligned"}
        </span>
      </div>
      <div className="chart-order-risk-row chart-order-guard-kpi-row">
        <span>RR target {chartRiskTargetRr.toFixed(2)}</span>
        <span>{chartRiskGuardEnabled ? "guard active" : "guard bypass"}</span>
      </div>
      {chartRiskTargetMiss ? <div className="chart-order-auto-confirm-hint">Auto rule: confirm-required active (gain cible non atteint).</div> : null}
      <div className="chart-order-risk-row chart-order-snap-row">
        <span>Step {chartPriceStep.toFixed(chartPriceDigits)}</span>
        <span>{chartSnapEnabledLabel}</span>
        <span>{chartSnapState ? chartSnapState.price.toFixed(chartPriceDigits) : ""}</span>
      </div>
      <div className="chart-order-risk-row chart-order-risk-sub">
        <span>Entry {chartOrderTicketEntryLabel}</span>
        <span>SL {chartOrderTicketSlLabel}</span>
        <span>TP {chartOrderTicketTpLabel}</span>
      </div>
      {uiMode === "novice" ? (
        <div className="chart-order-novice-tip">
          Stop Loss coupe la position pour limiter la perte. Fixe Perte max et Gain cible pour garder un profil RR clair avant envoi.
        </div>
      ) : null}
      <div className="chart-order-mini-row">
        {chartEffectiveSendMode === "confirm-required" ? (
          <button type="button" className={`chart-chip ${chartHudConfirmArmed ? "active" : ""}`} onClick={onToggleChartHudConfirmArmed}>
            {chartHudConfirmArmed ? "Armed" : "Arm Send"}
          </button>
        ) : null}
        <button type="button" className="chart-chip chart-buy-btn" onClick={onSubmitChartOrder}>
          {chartEffectiveSendMode === "confirm-required" ? "Confirm Send" : "Send"}
        </button>
        <button type="button" className="chart-chip" onClick={() => onApplyChartOrderPreset("scalp")}>Reset</button>
      </div>
      {mergedChartSendHistory.length > 0 ? (
        <div className="chart-order-send-history">
          <div className="chart-order-send-history-title">Last 5 sends</div>
          {mergedChartSendHistory.map((entry, index) => (
            <div key={`send-hist-${index}-${entry.atIso}`} className="chart-order-send-history-row">
              <span>{formatClock(entry.atIso)}</span>
              <span>{entry.symbol}</span>
              <span>{entry.side.toUpperCase()}</span>
              <span>RR {entry.rr.toFixed(2)}</span>
              <span className={entry.compliant ? "good" : "warn"}>{entry.compliant ? "limits_ok" : "limits_miss"}</span>
              <span className="subtle mini">{entry.source || "local"}</span>
              <span className={entry.outcome === "submitted" ? "good" : "warn"}>{entry.outcome === "confirmation-required" ? "confirm_required" : entry.outcome}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}