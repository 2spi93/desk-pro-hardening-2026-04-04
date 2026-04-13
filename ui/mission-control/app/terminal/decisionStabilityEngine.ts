import { resolveStateLabel, type DecisionState, type SmartDecisionSnapshot } from "./decisionEngine";

export type DecisionConfidenceBand = "LOW" | "MEDIUM" | "HIGH";

export type DecisionStability = {
  currentState: DecisionState;
  lastStableState: DecisionState;
  stabilityScore: number;
  persistenceMs: number;
  flipCount: number;
  isStable: boolean;
  confidenceBand: DecisionConfidenceBand;
};

type StabilityHistoryEntry = {
  state: DecisionState;
  ts: number;
};

type InternalState = {
  currentState: DecisionState | null;
  currentStateSinceTs: number;
  lastStableState: DecisionState | null;
  history: StabilityHistoryEntry[];
};

type DecisionStabilityOptions = {
  maxHistory?: number;
  stableThresholdMs?: number;
  maxFlipsWindowMs?: number;
};

const DEFAULT_MAX_HISTORY = 50;
const DEFAULT_STABLE_THRESHOLD_MS = 800;
const DEFAULT_MAX_FLIPS_WINDOW_MS = 2_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveConfidenceBand(score: number): DecisionConfidenceBand {
  if (score >= 0.72) {
    return "HIGH";
  }
  if (score >= 0.45) {
    return "MEDIUM";
  }
  return "LOW";
}

export function createDecisionStabilityEngine(options: DecisionStabilityOptions = {}) {
  const maxHistory = Math.max(4, Math.floor(options.maxHistory ?? DEFAULT_MAX_HISTORY));
  const stableThresholdMs = Math.max(200, Math.floor(options.stableThresholdMs ?? DEFAULT_STABLE_THRESHOLD_MS));
  const maxFlipsWindowMs = Math.max(stableThresholdMs, Math.floor(options.maxFlipsWindowMs ?? DEFAULT_MAX_FLIPS_WINDOW_MS));
  const state: InternalState = {
    currentState: null,
    currentStateSinceTs: 0,
    lastStableState: null,
    history: [],
  };

  function update(currentState: DecisionState, nowMs = Date.now()): DecisionStability {
    if (state.currentState !== currentState) {
      state.currentState = currentState;
      state.currentStateSinceTs = nowMs;
      state.history.push({ state: currentState, ts: nowMs });
      if (state.history.length > maxHistory) {
        state.history = state.history.slice(-maxHistory);
      }
    }

    state.history = state.history.filter((entry) => nowMs - entry.ts <= maxFlipsWindowMs);
    const persistenceMs = Math.max(0, nowMs - state.currentStateSinceTs);
    const flipCount = Math.max(0, state.history.length - 1);
    const stabilityScore = clamp(
      persistenceMs / stableThresholdMs - flipCount * 0.15,
      0,
      1,
    );
    const isStable = persistenceMs >= stableThresholdMs && flipCount <= 3;
    if (isStable || state.lastStableState === null) {
      state.lastStableState = currentState;
    }

    return {
      currentState,
      lastStableState: state.lastStableState ?? currentState,
      stabilityScore,
      persistenceMs,
      flipCount,
      isStable,
      confidenceBand: resolveConfidenceBand(stabilityScore),
    };
  }

  return { update };
}

export function applyDecisionStability(snapshot: SmartDecisionSnapshot, stability: DecisionStability): SmartDecisionSnapshot {
  const stabilityWeightedConfidence = clamp(
    snapshot.confidence * (0.55 + stability.stabilityScore * 0.45),
    0,
    1,
  );

  if (stability.flipCount >= 4) {
    return {
      ...snapshot,
      state: "NO_TRADE",
      stateLabel: resolveStateLabel("NO_TRADE"),
      confidence: Math.min(0.2, stabilityWeightedConfidence),
      headline: "Market unstable - no trade",
      reason: "Flip cluster detected in the decision stream; wait for regime stabilization before acting.",
      qualityGate: "fail",
      stability,
    };
  }

  if (!stability.isStable && snapshot.state === "ENTRY_VALID") {
    return {
      ...snapshot,
      state: "WAIT_CONFIRMATION",
      stateLabel: resolveStateLabel("WAIT_CONFIRMATION"),
      confidence: Math.min(0.42, stabilityWeightedConfidence),
      headline: "Signal unstable - wait",
      reason: `Entry signal has not persisted long enough (${stability.persistenceMs}ms, ${stability.flipCount} flips).`,
      qualityGate: snapshot.qualityGate === "pass" ? "warn" : snapshot.qualityGate,
      stability,
    };
  }

  return {
    ...snapshot,
    confidence: stabilityWeightedConfidence,
    reason: !stability.isStable && snapshot.state !== "NO_TRADE"
      ? `${snapshot.reason} Signal still settling (${stability.persistenceMs}ms, ${stability.flipCount} flips).`
      : snapshot.reason,
    stability,
  };
}