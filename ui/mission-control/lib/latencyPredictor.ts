export type LatencyPredictorVenue = {
  venue: string;
  ts: number;
};

export type LatencyPredictorHistory = {
  latencyGap: number[];
};

export type LatencyPrediction = {
  expectedLag: number;
  currentLag: number;
  trend: number;
  confidence: number;
  preArm: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function movingAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function predictLatencyShift(input: {
  venueA: LatencyPredictorVenue;
  venueB: LatencyPredictorVenue;
  history: LatencyPredictorHistory;
  thresholdMs?: number;
}): LatencyPrediction {
  const currentLag = input.venueA.ts - input.venueB.ts;
  const trend = movingAverage((input.history.latencyGap || []).slice(-12));
  const expectedLag = currentLag + trend;
  const thresholdMs = Math.max(1, input.thresholdMs ?? 15);
  return {
    expectedLag,
    currentLag,
    trend,
    confidence: clamp(Math.abs(trend) / Math.max(thresholdMs, 1), 0, 1),
    preArm: Math.abs(expectedLag) >= thresholdMs,
  };
}