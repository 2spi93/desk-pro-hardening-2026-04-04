import type { SmartDecisionHudShape } from "./chartHudTypes";

type SmartDecisionSummaryProps = {
  decision: SmartDecisionHudShape;
  variant?: "hero" | "operator";
  showLevels?: boolean;
};

export default function SmartDecisionSummary({
  decision,
  variant = "hero",
  showLevels = true,
}: SmartDecisionSummaryProps) {
  const stateClassName = variant === "hero"
    ? `terminal-v2-decision-state terminal-v2-decision-state-${decision.state.toLowerCase()}${decision.stability.isStable ? "" : " unstable"}`
    : `smart-decision-summary-state smart-decision-summary-state-${decision.state.toLowerCase()}${decision.stability.isStable ? "" : " unstable"}`;

  return (
    <div className={`smart-decision-summary smart-decision-summary-${variant} tone-${decision.tone}`}>
      <div className="smart-decision-summary-head-row">
        <div className={stateClassName} data-smart-decision-state={decision.state}>
          <strong>{decision.displayStateLabel}</strong>
          <span>{decision.confidenceBand}</span>
        </div>
        <div className={`smart-decision-summary-stability ${decision.stability.isStable ? "stable" : "unstable"}`}>
          {decision.stability.statusLabel}
        </div>
      </div>
      <div className={variant === "hero" ? "terminal-v2-decision-headline smart-decision-summary-headline" : "smart-decision-summary-headline"}>
        {decision.headline}
      </div>
      <p className={`${variant === "hero" ? "terminal-v2-ai-copy terminal-v2-decision-copy " : ""}smart-decision-summary-copy`}>
        {decision.reason}
      </p>
      <div className={variant === "hero" ? "terminal-v2-decision-metrics smart-decision-summary-metrics" : "smart-decision-summary-metrics"}>
        <span className={`terminal-v2-decision-chip ${decision.qualityGate}`}>gate {decision.qualityGateLabel}</span>
        <span className="terminal-v2-decision-chip">regime {decision.regimeLabel}</span>
        <span className="terminal-v2-decision-chip">structure {decision.structureLabel}</span>
        <span className="terminal-v2-decision-chip">liquidity {decision.liquidityLabel}</span>
      </div>
      {showLevels ? (
        <div className="perception-levels smart-decision-summary-levels">
          <div className="perception-level">
            <span className="perception-label">TRIGGER</span>
            <span className="perception-value">{decision.triggerLabel}</span>
          </div>
          <div className="perception-level">
            <span className="perception-label">INVALID</span>
            <span className="perception-value warn">{decision.invalidationLabel}</span>
          </div>
          <div className="perception-level">
            <span className="perception-label">LATENCY</span>
            <span className="perception-value">{decision.latencyLabel}</span>
          </div>
        </div>
      ) : null}
      <div className="smart-decision-summary-foot">
        <span>stability {decision.stability.stabilityScorePct}%</span>
        <span>{decision.stability.persistenceLabel}</span>
        <span>{decision.stability.flipCount} flip{decision.stability.flipCount > 1 ? "s" : ""}</span>
        <span>last stable {decision.stability.lastStableStateLabel}</span>
      </div>
    </div>
  );
}