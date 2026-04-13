import type { LiquiditySnapshot } from "./liquidityEngine";
import type { RegimeSnapshot } from "./regimeEngine";
import type { StructureSnapshot } from "./structureEngine";
import type { DecisionStability } from "./decisionStabilityEngine";

export type SmartDecisionState = "NO_TRADE" | "WAIT_CONFIRMATION" | "FAKE_BREAKOUT_RISK" | "ENTRY_VALID";
export type SmartDecisionSide = "long" | "short" | "neutral";
export type DecisionState = SmartDecisionState;

export type SmartDecisionSnapshot = {
  state: SmartDecisionState;
  stateLabel: string;
  confidence: number;
  headline: string;
  reason: string;
  triggerSide: SmartDecisionSide;
  trigger: number | null;
  invalidation: number | null;
  regimeLabel: string;
  structureLabel: string;
  liquidityLabel: string;
  qualityGate: "pass" | "warn" | "fail";
  decisionLatencyMs: number | null;
  stability?: DecisionStability;
};

type ResolveDecisionInput = {
  regime: RegimeSnapshot;
  structure: StructureSnapshot;
  liquidity: LiquiditySnapshot;
  predictionDirection: "LONG" | "SHORT" | "WAIT";
  predictionProbability: number;
  predictionTrigger: number | null;
  predictionInvalidation: number | null;
  lowFlowEdgeBlocked: boolean;
  routeScorePct: number;
  domImbalance: number;
  decisionLatencyMs?: number | null;
  suspended?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveStateLabel(state: SmartDecisionState): string {
  switch (state) {
    case "NO_TRADE":
      return "NO TRADE";
    case "WAIT_CONFIRMATION":
      return "WAIT CONFIRMATION";
    case "FAKE_BREAKOUT_RISK":
      return "FAKE BREAKOUT RISK";
    case "ENTRY_VALID":
      return "ENTRY VALID";
    default:
      return state;
  }
}

function resolveQualityGate(score: number): "pass" | "warn" | "fail" {
  if (score >= 0.7) {
    return "pass";
  }
  if (score >= 0.48) {
    return "warn";
  }
  return "fail";
}

export function resolveSmartDecision(input: ResolveDecisionInput): SmartDecisionSnapshot {
  const triggerSide: SmartDecisionSide = input.predictionDirection === "LONG"
    ? "long"
    : input.predictionDirection === "SHORT"
      ? "short"
      : "neutral";
  const directionalAligned = (input.regime.state === "BULL" && triggerSide === "long")
    || (input.regime.state === "BEAR" && triggerSide === "short");
  const fakeBreakoutAgainstDirection = triggerSide === "long"
    ? input.liquidity.equalHighs.some((cluster) => cluster.sweepDetected && cluster.rejectionDetected)
    : triggerSide === "short"
      ? input.liquidity.equalLows.some((cluster) => cluster.sweepDetected && cluster.rejectionDetected)
      : input.liquidity.fakeBreakoutRisk;
  const confidence = clamp(
    input.predictionProbability / 100 * 0.46
      + input.regime.alignmentStrength * 0.32
      + input.structure.confidence * 0.22,
    0,
    1,
  );
  const strongDirectionalSetup = directionalAligned
    && input.regime.state !== "RANGE"
    && input.predictionProbability >= 72
    && input.structure.impulseScore >= 0.55
    && input.routeScorePct >= 65
    && input.regime.alignmentStrength >= 0.28;
  const qualityGate = resolveQualityGate(confidence);
  const regimeLabel = `${input.regime.state} ${Math.round(input.regime.alignmentStrength * 100)}%`;
  const structureLabel = `${input.structure.summaryLabel} · impulse ${Math.round(input.structure.impulseScore * 100)}%`;
  const liquidityLabel = input.liquidity.fakeBreakoutRisk
    ? "sweep rejection detected"
    : input.liquidity.stopClusters.length > 0
      ? `${input.liquidity.stopClusters.length} live liquidity clusters`
      : "no dominant liquidity cluster";

  if (input.suspended || input.lowFlowEdgeBlocked) {
    return {
      state: "NO_TRADE",
      stateLabel: resolveStateLabel("NO_TRADE"),
      confidence,
      headline: "Execution suspended",
      reason: input.suspended ? "Preview or degraded feed blocks the decision layer" : "Low flow edge blocks execution quality",
      triggerSide,
      trigger: input.predictionTrigger,
      invalidation: input.predictionInvalidation,
      regimeLabel,
      structureLabel,
      liquidityLabel,
      qualityGate: "fail",
      decisionLatencyMs: input.decisionLatencyMs ?? null,
    };
  }

  if (fakeBreakoutAgainstDirection) {
    return {
      state: "FAKE_BREAKOUT_RISK",
      stateLabel: resolveStateLabel("FAKE_BREAKOUT_RISK"),
      confidence,
      headline: "Liquidity sweep against trigger",
      reason: `Liquidity rejects the current ${triggerSide === "neutral" ? "break" : triggerSide} trigger path`,
      triggerSide,
      trigger: input.predictionTrigger,
      invalidation: input.predictionInvalidation,
      regimeLabel,
      structureLabel,
      liquidityLabel,
      qualityGate: qualityGate === "pass" ? "warn" : qualityGate,
      decisionLatencyMs: input.decisionLatencyMs ?? null,
    };
  }

  if (input.regime.state === "CONFLICT" && (input.regime.alignmentStrength < 0.62 || input.predictionProbability < 58)) {
    return {
      state: "NO_TRADE",
      stateLabel: resolveStateLabel("NO_TRADE"),
      confidence,
      headline: "Horizons disagree",
      reason: input.regime.reason,
      triggerSide,
      trigger: input.predictionTrigger,
      invalidation: input.predictionInvalidation,
      regimeLabel,
      structureLabel,
      liquidityLabel,
      qualityGate,
      decisionLatencyMs: input.decisionLatencyMs ?? null,
    };
  }

  if (
    !directionalAligned
    || input.regime.state === "RANGE"
    || input.predictionDirection === "WAIT"
    || input.predictionProbability < 60
    || (input.regime.alignmentStrength < 0.58 && !strongDirectionalSetup)
    || input.structure.impulseScore < 0.42
    || input.routeScorePct < 52
  ) {
    return {
      state: "WAIT_CONFIRMATION",
      stateLabel: resolveStateLabel("WAIT_CONFIRMATION"),
      confidence,
      headline: "Setup visible, trigger not clean enough",
      reason: input.regime.state === "RANGE"
        ? "Range regime requires confirmation before entry"
        : !directionalAligned
          ? "Prediction direction is not aligned with the dominant regime"
          : input.routeScorePct < 52
            ? "Route quality is not clean enough yet"
            : "Structure impulse or confidence still needs confirmation",
      triggerSide,
      trigger: input.predictionTrigger,
      invalidation: input.predictionInvalidation,
      regimeLabel,
      structureLabel,
      liquidityLabel,
      qualityGate,
      decisionLatencyMs: input.decisionLatencyMs ?? null,
    };
  }

  return {
    state: "ENTRY_VALID",
    stateLabel: resolveStateLabel("ENTRY_VALID"),
    confidence,
    headline: triggerSide === "short" ? "Short entry validated" : "Long entry validated",
    reason: `Regime, structure and execution quality align for a ${triggerSide} entry`,
    triggerSide,
    trigger: input.predictionTrigger,
    invalidation: input.predictionInvalidation,
    regimeLabel,
    structureLabel,
    liquidityLabel,
    qualityGate,
    decisionLatencyMs: input.decisionLatencyMs ?? null,
  };
}