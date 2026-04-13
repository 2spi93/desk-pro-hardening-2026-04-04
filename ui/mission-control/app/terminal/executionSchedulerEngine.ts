type SchedulerLifecycleTelemetry = Record<string, unknown>;

export type BrokerAwareSchedulerAction = "EXECUTE" | "CANCEL_REPLACE" | "RESLICE" | "BLOCK";

export type BrokerAwareSchedulerMode = "SEQUENTIAL" | "QUEUE_AWARE" | "ADAPTIVE_RESLICE" | "CANCEL_REPLACE";

export type BrokerAwareReplaceStrategy = "cancel_replace" | "modify" | "reslice_only";

export type BrokerAwareSchedulerChildOrder = {
  id: string;
  venue: string;
  notionalUsd: number;
  plannedDelayMs: number;
  state: "planned" | "working" | "partial" | "filled" | "replace" | "blocked";
  replaceCount: number;
  fillRatio: number;
  resliceEligible: boolean;
};

export type BrokerAwareSchedulerSnapshot = {
  mode: BrokerAwareSchedulerMode;
  action: BrokerAwareSchedulerAction;
  venue: string;
  provider: string;
  childOrders: BrokerAwareSchedulerChildOrder[];
  activeChildState: string;
  averageFillRatio: number;
  partialFillRatio: number;
  scheduleScore: number;
  replaceBudget: number;
  supportsModify: boolean;
  supportsCancelReplace: boolean;
  replaceStrategy: BrokerAwareReplaceStrategy;
  resliceCount: number;
  reasonPills: string[];
};

export type BrokerAwareSchedulerInput = {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  venue: string;
  provider: string;
  baseSlices: number;
  baseDelayMs: number;
  guardAction: string;
  supportsModify: boolean;
  supportsCancelReplace: boolean;
  fillProbability: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  hiddenLiquidity: number;
  spoofProbability: number;
  sweepRisk: number;
  fusionDeviationBps: number;
  predictedDeltaBps: number;
  microBurstRate: number;
  routeScore: number;
  pendingApprovals: number;
  lifecycleTelemetry: SchedulerLifecycleTelemetry[];
  forcedAction?: BrokerAwareSchedulerAction;
  forcedChildCount?: number;
  forcedReplaceBudget?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function deriveChildOrderLifecycle(lifecycleTelemetry: SchedulerLifecycleTelemetry[]): {
  averageFillRatio: number;
  partialFillRatio: number;
  blockedRatio: number;
  acceptedRatio: number;
  activeState: "planned" | "working" | "partial" | "filled" | "replace" | "blocked";
} {
  if (lifecycleTelemetry.length === 0) {
    return {
      averageFillRatio: 1,
      partialFillRatio: 0,
      blockedRatio: 0,
      acceptedRatio: 0,
      activeState: "planned",
    };
  }

  let accepted = 0;
  let partial = 0;
  let filled = 0;
  let blocked = 0;
  let fillRatioSum = 0;

  for (const item of lifecycleTelemetry) {
    const status = String(item.status || item.execution_status || item.order_status || "").toLowerCase();
    const fillRatio = clamp(
      toNumber(
        item.fill_ratio ?? item.executed_ratio,
        /fill|closed|done|complete/.test(status) ? 1 : /partial/.test(status) ? 0.5 : /reject|block|cancel|error|fail/.test(status) ? 0 : 1,
      ),
      0,
      1,
    );
    fillRatioSum += fillRatio;

    if (/reject|block|cancel|error|fail/.test(status)) {
      blocked += 1;
      continue;
    }
    if (Boolean(item.ts_fill_final) || /fill|closed|done|complete/.test(status) || fillRatio >= 0.99) {
      filled += 1;
      accepted += 1;
      continue;
    }
    if (Boolean(item.ts_fill_partial) || /partial/.test(status) || (fillRatio > 0 && fillRatio < 0.99)) {
      partial += 1;
      accepted += 1;
      continue;
    }
    if (Boolean(item.ts_broker_accept) || /accept|ack|submit|work/.test(status)) {
      accepted += 1;
    }
  }

  const total = Math.max(1, lifecycleTelemetry.length);
  const averageFillRatio = fillRatioSum / total;
  const partialFillRatio = partial / total;
  const blockedRatio = blocked / total;
  const acceptedRatio = accepted / total;
  const activeState = blocked > 0
    ? "blocked"
    : partial > 0
      ? "partial"
      : filled > 0
        ? "filled"
        : accepted > 0
          ? "working"
          : "planned";

  return {
    averageFillRatio,
    partialFillRatio,
    blockedRatio,
    acceptedRatio,
    activeState,
  };
}

export function scheduleChildOrders(
  input: BrokerAwareSchedulerInput,
  mode: BrokerAwareSchedulerMode,
  replaceBudget = 0,
): BrokerAwareSchedulerChildOrder[] {
  const lifecycle = deriveChildOrderLifecycle(input.lifecycleTelemetry);
  const baseSlices = clamp(Math.round(input.baseSlices || 1), 1, 8);
  const reslicePressure = clamp(
    lifecycle.partialFillRatio * 1.3
      + Math.max(0, 1 - lifecycle.averageFillRatio) * 0.9
      + input.sweepRisk * 0.45
      + Math.abs(input.predictedDeltaBps) / 20,
    0,
    2.5,
  );
  const computedChildCount = clamp(
    baseSlices
      + (mode === "ADAPTIVE_RESLICE" ? 1 : 0)
      + (mode === "CANCEL_REPLACE" ? 1 : 0)
      + Math.round(reslicePressure),
    1,
    8,
  );
  const childCount = clamp(input.forcedChildCount ?? computedChildCount, 1, 8);
  const minChildNotionalUsd = input.notionalUsd >= 250 ? 50 : 25;
  const rawWeights = Array.from({ length: childCount }, (_, index) => {
    if (mode === "QUEUE_AWARE") {
      return index === 0 ? 1.25 : 0.92;
    }
    if (mode === "ADAPTIVE_RESLICE" || mode === "CANCEL_REPLACE") {
      return Math.max(0.45, 1 - index * 0.08);
    }
    return 1;
  });
  const totalWeight = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
  let remainder = Math.max(0, input.notionalUsd);

  return rawWeights.map((weight, index) => {
    const provisionalNotional = index === rawWeights.length - 1
      ? remainder
      : Math.max(minChildNotionalUsd, Number(((input.notionalUsd * weight) / totalWeight).toFixed(2)));
    const childNotionalUsd = Math.min(remainder, provisionalNotional);
    remainder = Math.max(0, Number((remainder - childNotionalUsd).toFixed(2)));
    const replaceCount = mode === "CANCEL_REPLACE" && index < replaceBudget ? 1 : 0;
    const state: BrokerAwareSchedulerChildOrder["state"] = lifecycle.activeState === "partial" && index === 0
      ? "partial"
      : lifecycle.activeState === "blocked"
        ? "blocked"
        : replaceCount > 0 && index === 0
          ? "replace"
          : lifecycle.activeState === "filled" && index === rawWeights.length - 1
            ? "filled"
            : lifecycle.acceptedRatio > 0 && index === 0
              ? "working"
              : "planned";

    return {
      id: `${input.symbol}-${input.side}-${index + 1}`,
      venue: input.venue,
      notionalUsd: Number(childNotionalUsd.toFixed(2)),
      plannedDelayMs: Math.max(0, Number((input.baseDelayMs * (index === 0 ? 0 : 1 + Math.min(0.75, reslicePressure * 0.18))).toFixed(0))),
      state,
      replaceCount,
      fillRatio: state === "partial" ? lifecycle.averageFillRatio : state === "filled" ? 1 : 0,
      resliceEligible: mode !== "SEQUENTIAL" && index < rawWeights.length - 1,
    };
  }).filter((child) => child.notionalUsd > 0);
}

export function buildBrokerAwareSchedulerSnapshot(input: BrokerAwareSchedulerInput): BrokerAwareSchedulerSnapshot {
  const lifecycle = deriveChildOrderLifecycle(input.lifecycleTelemetry);
  const routeScore = clamp(input.routeScore > 1 ? input.routeScore / 100 : input.routeScore, 0, 1);
  const replaceStrategy: BrokerAwareReplaceStrategy = input.supportsModify
    ? "modify"
    : input.supportsCancelReplace
      ? "cancel_replace"
      : "reslice_only";
  const cancelReplacePressure = clamp(
    lifecycle.partialFillRatio * 0.42
      + lifecycle.blockedRatio * 0.28
      + clamp(input.avgLatencyMs / 700, 0, 1) * 0.1
      + clamp(Math.abs(input.avgSlippageBps) / 18, 0, 1) * 0.08
      + input.spoofProbability * 0.07
      + Math.abs(input.fusionDeviationBps) / 36
      + Math.abs(input.predictedDeltaBps) / 44,
    0,
    1,
  );
  const reslicePressure = clamp(
    lifecycle.partialFillRatio * 0.48
      + Math.max(0, 1 - lifecycle.averageFillRatio) * 0.2
      + input.hiddenLiquidity * 0.12
      + input.sweepRisk * 0.1
      + Math.max(0, 1 - input.fillProbability) * 0.1,
    0,
    1,
  );

  const forcedAction = input.forcedAction;
  const desiredCancelReplace = forcedAction === "CANCEL_REPLACE" || cancelReplacePressure >= 0.62;
  const action: BrokerAwareSchedulerAction = input.guardAction === "BLOCK" || input.pendingApprovals >= 6
    ? "BLOCK"
    : forcedAction === "BLOCK"
      ? "BLOCK"
      : forcedAction === "EXECUTE"
        ? "EXECUTE"
        : forcedAction === "RESLICE"
          ? "RESLICE"
          : desiredCancelReplace
            ? replaceStrategy === "reslice_only"
              ? "RESLICE"
              : "CANCEL_REPLACE"
            : reslicePressure >= 0.45
              ? "RESLICE"
              : "EXECUTE";
  const mode: BrokerAwareSchedulerMode = action === "CANCEL_REPLACE"
    ? "CANCEL_REPLACE"
    : action === "RESLICE"
      ? "ADAPTIVE_RESLICE"
      : input.pendingApprovals > 0 || input.hiddenLiquidity >= 0.55
        ? "QUEUE_AWARE"
        : "SEQUENTIAL";
  const replaceBudget = action === "CANCEL_REPLACE"
    ? clamp(input.forcedReplaceBudget ?? Math.min(2, Math.max(1, Math.round(cancelReplacePressure * 2))), 1, 2)
    : 0;
  const childOrders = scheduleChildOrders(input, mode, replaceBudget);
  const scheduleScore = clamp(
    input.fillProbability * 0.32
      + routeScore * 0.18
      + Math.max(0, 1 - clamp(input.avgLatencyMs / 900, 0, 1)) * 0.14
      + Math.max(0, 1 - clamp(Math.abs(input.avgSlippageBps) / 24, 0, 1)) * 0.14
      + Math.max(0, 1 - cancelReplacePressure) * 0.12
      + Math.max(0, 1 - reslicePressure) * 0.1,
    0,
    1,
  );
  const resliceCount = Math.max(0, childOrders.length - clamp(Math.round(input.baseSlices || 1), 1, 8));
  const reasonPills: string[] = [];

  if (input.pendingApprovals > 0) {
    reasonPills.push(`pending:${input.pendingApprovals}`);
  }
  if (lifecycle.partialFillRatio > 0) {
    reasonPills.push(`partial:${(lifecycle.partialFillRatio * 100).toFixed(0)}%`);
  }
  if (replaceBudget > 0) {
    reasonPills.push(`replace:x${replaceBudget}`);
  }
  reasonPills.push(input.supportsCancelReplace ? "cap:cancel-replace" : "cap:no-cancel-replace");
  reasonPills.push(input.supportsModify ? "cap:modify" : "cap:no-modify");
  if (desiredCancelReplace && replaceStrategy === "reslice_only") {
    reasonPills.push("cap:downgraded-reslice");
  }
  if (resliceCount > 0) {
    reasonPills.push(`reslice:+${resliceCount}`);
  }
  if (input.hiddenLiquidity >= 0.45) {
    reasonPills.push(`hidden:${(input.hiddenLiquidity * 100).toFixed(0)}%`);
  }
  if (input.sweepRisk >= 0.45) {
    reasonPills.push(`sweep:${(input.sweepRisk * 100).toFixed(0)}%`);
  }
  if (action === "BLOCK") {
    reasonPills.push("guard:block");
  }

  return {
    mode,
    action,
    venue: input.venue,
    provider: input.provider,
    childOrders,
    activeChildState: childOrders[0]?.state || lifecycle.activeState,
    averageFillRatio: lifecycle.averageFillRatio,
    partialFillRatio: lifecycle.partialFillRatio,
    scheduleScore,
    replaceBudget,
    supportsModify: input.supportsModify,
    supportsCancelReplace: input.supportsCancelReplace,
    replaceStrategy,
    resliceCount,
    reasonPills,
  };
}