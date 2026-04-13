import { resolveStateLabel, type SmartDecisionSnapshot } from "./decisionEngine";
import type { SmartDecisionHudShape, SmartDecisionHudTone } from "./chartHudTypes";

function formatDecisionPrice(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}

function formatDecisionLatency(latencyMs: number | null): string {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return "n/a";
  }
  if (latencyMs < 1_000) {
    return `${Math.round(latencyMs)}ms`;
  }
  return `${(latencyMs / 1_000).toFixed(latencyMs < 10_000 ? 1 : 0)}s`;
}

function formatPersistenceLabel(persistenceMs: number): string {
  if (!Number.isFinite(persistenceMs) || persistenceMs <= 0) {
    return "0ms";
  }
  if (persistenceMs < 1_000) {
    return `${Math.round(persistenceMs)}ms`;
  }
  return `${(persistenceMs / 1_000).toFixed(persistenceMs < 10_000 ? 1 : 0)}s`;
}

function resolveDecisionTone(state: SmartDecisionSnapshot["state"]): SmartDecisionHudTone {
  switch (state) {
    case "ENTRY_VALID":
      return "good";
    case "WAIT_CONFIRMATION":
      return "subtle";
    case "FAKE_BREAKOUT_RISK":
    case "NO_TRADE":
    default:
      return "warn";
  }
}

export function buildSmartDecisionHud(snapshot: SmartDecisionSnapshot): SmartDecisionHudShape {
  const confidencePct = Math.round(snapshot.confidence * 100);
  const qualityGateLabel = snapshot.qualityGate.toUpperCase();
  const fallbackConfidenceBand = confidencePct >= 72 ? "HIGH" : confidencePct >= 45 ? "MEDIUM" : "LOW";
  const stability = snapshot.stability ?? {
    currentState: snapshot.state,
    lastStableState: snapshot.state,
    stabilityScore: snapshot.state === "ENTRY_VALID" ? 1 : 0,
    persistenceMs: 0,
    flipCount: 0,
    isStable: snapshot.state === "ENTRY_VALID",
    confidenceBand: fallbackConfidenceBand,
  };
  const persistenceLabel = formatPersistenceLabel(stability.persistenceMs);
  const stabilityScorePct = Math.round(stability.stabilityScore * 100);
  const displayStateLabel = stability.isStable ? snapshot.stateLabel : "UNSTABLE";
  const stabilityStatusLabel = stability.isStable
    ? `stable · ${persistenceLabel}`
    : `unstable · ${stability.flipCount} flip${stability.flipCount > 1 ? "s" : ""}`;

  return {
    state: snapshot.state,
    stateLabel: snapshot.stateLabel,
    displayStateLabel,
    tone: resolveDecisionTone(snapshot.state),
    confidencePct,
    confidenceBand: stability.confidenceBand,
    headline: snapshot.headline,
    reason: snapshot.reason,
    regimeLabel: snapshot.regimeLabel,
    structureLabel: snapshot.structureLabel,
    liquidityLabel: snapshot.liquidityLabel,
    qualityGate: snapshot.qualityGate,
    qualityGateLabel,
    triggerSide: snapshot.triggerSide,
    triggerLabel: formatDecisionPrice(snapshot.trigger),
    invalidationLabel: formatDecisionPrice(snapshot.invalidation),
    latencyLabel: formatDecisionLatency(snapshot.decisionLatencyMs),
    compactLabel: `${displayStateLabel} · ${stability.confidenceBand} · ${snapshot.regimeLabel}`,
    assistantSummary: `${displayStateLabel}: ${snapshot.headline}. ${snapshot.reason}. Confidence ${stability.confidenceBand}. Stability ${stabilityStatusLabel}. Gate ${qualityGateLabel}. Regime ${snapshot.regimeLabel}. Structure ${snapshot.structureLabel}. Liquidity ${snapshot.liquidityLabel}.`,
    stability: {
      currentStateLabel: snapshot.stateLabel,
      lastStableStateLabel: snapshot.stability ? resolveStateLabel(snapshot.stability.lastStableState) : snapshot.stateLabel,
      stabilityScorePct,
      persistenceMs: stability.persistenceMs,
      persistenceLabel,
      flipCount: stability.flipCount,
      isStable: stability.isStable,
      confidenceBand: stability.confidenceBand,
      statusLabel: stabilityStatusLabel,
    },
  };
}