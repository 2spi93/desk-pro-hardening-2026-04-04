import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

const SELF_LEARNING_V5_VERSION = 1;
const SELF_LEARNING_V5_BASE_DIR = process.env.MC_SELF_LEARNING_V5_DIR
  || path.resolve(process.cwd(), "../../data/mission-control/self-learning-v5");

export type SelfLearningV5Scope = {
  accountId: string;
  symbol: string;
  timeframe: string;
};

export type SelfLearningV5Frame = {
  id: string;
  timestampIso: string;
  features: {
    absorptionProb: number;
    imbalance: number;
    delta: number;
    domDensity: number;
    liquidityWall: number;
    liquidityVacuum: number;
    microScore: number;
    spoofingRisk: number;
    mlProbability: number;
  };
  context: {
    trend: string;
    volatility: number;
    spread: number;
    regime: string;
  };
  outcome: {
    pnl: number;
    maxDrawdown: number;
    success: boolean;
  };
  source: {
    strategyId: string;
    executionMode: string;
  };
};

export type SelfLearningV5StrategyParams = {
  absorptionThreshold: number;
  imbalanceWeight: number;
  domWeight: number;
  liquidityWeight: number;
  mlWeight: number;
  microScoreFloor: number;
  mlProbabilityFloor: number;
};

export type SelfLearningV5RegistryEntry = {
  id: string;
  createdAt: string;
  status: "rejected" | "registry" | "shadow" | "live-blocked" | "live";
  params: SelfLearningV5StrategyParams;
  metrics: {
    trades: number;
    winratePct: number;
    avgPnl: number;
    drawdownPct: number;
    sharpe: number;
    overfitGapPct: number;
    score: number;
  };
  validation: {
    accepted: boolean;
    reasons: string[];
    liveEligible: boolean;
    liveBlockedReasons: string[];
  };
};
export type SelfLearningV5RegistryObservation = {
  candidateStrategyId: string | null;
  requiredShadowCycles: number;
  requiredObservationHours: number;
  observedShadowCycles: number;
  observedObservationHours: number;
  eligibleForPromotion: boolean;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  reasons: string[];
};

export type SelfLearningV5PromotionAudit = {
  strategyId: string;
  promotedAt: string;
  promotedBy: string;
  rationale: string;
  fromStatus: string;
  toStatus: "live";
  observation: {
    requiredShadowCycles: number;
    requiredObservationHours: number;
    observedShadowCycles: number;
    observedObservationHours: number;
  };
};

export type SelfLearningV5CycleSummary = {
  id: string;
  timestampIso: string;
  summary: string;
  bestStrategyId: string | null;
  acceptedVariants: number;
  liveBlocked: boolean;
};

export type SelfLearningV5State = {
  version: number;
  accountId: string;
  symbol: string;
  timeframe: string;
  enabled: boolean;
  strictValidation: boolean;
  allowLiveDeployment: boolean;
  modelUpdatedAt: string | null;
  snapshot: {
    dataset: {
      sampleSize: number;
      successRatePct: number;
      avgPnl: number;
      lastFrameAt: string | null;
      featureCoveragePct: number;
    };
    optimizer: {
      runId: string;
      ranAt: string;
      generatedVariants: number;
      evaluatedVariants: number;
      acceptedVariants: number;
      rejectedVariants: number;
      bestStrategyId: string | null;
      bestScore: number;
    };
    validation: {
      strict: boolean;
      thresholds: {
        minWinratePct: number;
        maxDrawdownPct: number;
        minSharpe: number;
        maxOverfitGapPct: number;
        minTrades: number;
      };
      liveBlocked: boolean;
      liveBlockReasons: string[];
    };
    registry: {
      activeShadowStrategyId: string | null;
      activeLiveStrategyId: string | null;
      observation: SelfLearningV5RegistryObservation;
      promotionAuditTrail: SelfLearningV5PromotionAudit[];
      entries: SelfLearningV5RegistryEntry[];
    };
    datasetPreview: SelfLearningV5Frame[];
  };
  cycles: SelfLearningV5CycleSummary[];
  updatedAt: string;
};

export type SelfLearningV5ScopeSummary = {
  accountId: string;
  symbol: string;
  timeframe: string;
  updatedAt: string;
  cycleCount: number;
  registryCount: number;
  enabled: boolean;
  strictValidation: boolean;
  liveBlocked: boolean;
};

function safeSegment(value: string, fallback: string): string {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96);
  return normalized || fallback;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function sanitizeScope(scope: { accountId?: unknown; symbol?: unknown; timeframe?: unknown } | null | undefined): SelfLearningV5Scope | null {
  if (!scope) {
    return null;
  }
  const accountId = String(scope.accountId || "").trim();
  const symbol = String(scope.symbol || "").trim().toUpperCase();
  const timeframe = String(scope.timeframe || "").trim().toLowerCase();
  if (!accountId || !symbol || !timeframe) {
    return null;
  }
  return { accountId, symbol, timeframe };
}

function sanitizeFrame(value: unknown): SelfLearningV5Frame | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const features = candidate.features && typeof candidate.features === "object" ? candidate.features as Record<string, unknown> : {};
  const context = candidate.context && typeof candidate.context === "object" ? candidate.context as Record<string, unknown> : {};
  const outcome = candidate.outcome && typeof candidate.outcome === "object" ? candidate.outcome as Record<string, unknown> : {};
  const source = candidate.source && typeof candidate.source === "object" ? candidate.source as Record<string, unknown> : {};
  const id = String(candidate.id || "").trim();
  const timestampIso = String(candidate.timestampIso || "").trim() || new Date().toISOString();
  if (!id) {
    return null;
  }
  return {
    id,
    timestampIso,
    features: {
      absorptionProb: toFiniteNumber(features.absorptionProb, 0),
      imbalance: toFiniteNumber(features.imbalance, 0),
      delta: toFiniteNumber(features.delta, 0),
      domDensity: toFiniteNumber(features.domDensity, 0),
      liquidityWall: toFiniteNumber(features.liquidityWall, 0),
      liquidityVacuum: toFiniteNumber(features.liquidityVacuum, 0),
      microScore: toFiniteNumber(features.microScore, 0),
      spoofingRisk: toFiniteNumber(features.spoofingRisk, 0),
      mlProbability: toFiniteNumber(features.mlProbability, 0),
    },
    context: {
      trend: String(context.trend || "flat"),
      volatility: toFiniteNumber(context.volatility, 0),
      spread: toFiniteNumber(context.spread, 0),
      regime: String(context.regime || "unknown"),
    },
    outcome: {
      pnl: toFiniteNumber(outcome.pnl, 0),
      maxDrawdown: toFiniteNumber(outcome.maxDrawdown, 0),
      success: toBoolean(outcome.success, false),
    },
    source: {
      strategyId: String(source.strategyId || "unknown"),
      executionMode: String(source.executionMode || "unknown"),
    },
  };
}

function sanitizeParams(value: unknown): SelfLearningV5StrategyParams {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    absorptionThreshold: toFiniteNumber(candidate.absorptionThreshold, 0.8),
    imbalanceWeight: toFiniteNumber(candidate.imbalanceWeight, 0.25),
    domWeight: toFiniteNumber(candidate.domWeight, 0.2),
    liquidityWeight: toFiniteNumber(candidate.liquidityWeight, 0.15),
    mlWeight: toFiniteNumber(candidate.mlWeight, 0.2),
    microScoreFloor: toFiniteNumber(candidate.microScoreFloor, 0.75),
    mlProbabilityFloor: toFiniteNumber(candidate.mlProbabilityFloor, 0.7),
  };
}

function sanitizeRegistryEntry(value: unknown): SelfLearningV5RegistryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const metrics = candidate.metrics && typeof candidate.metrics === "object" ? candidate.metrics as Record<string, unknown> : {};
  const validation = candidate.validation && typeof candidate.validation === "object" ? candidate.validation as Record<string, unknown> : {};
  const id = String(candidate.id || "").trim();
  if (!id) {
    return null;
  }
  const status = ["rejected", "registry", "shadow", "live-blocked", "live"].includes(String(candidate.status || ""))
    ? String(candidate.status) as SelfLearningV5RegistryEntry["status"]
    : "registry";
  return {
    id,
    createdAt: String(candidate.createdAt || new Date().toISOString()),
    status,
    params: sanitizeParams(candidate.params),
    metrics: {
      trades: Math.max(0, Math.round(toFiniteNumber(metrics.trades, 0))),
      winratePct: toFiniteNumber(metrics.winratePct, 0),
      avgPnl: toFiniteNumber(metrics.avgPnl, 0),
      drawdownPct: toFiniteNumber(metrics.drawdownPct, 0),
      sharpe: toFiniteNumber(metrics.sharpe, 0),
      overfitGapPct: toFiniteNumber(metrics.overfitGapPct, 0),
      score: toFiniteNumber(metrics.score, 0),
    },
    validation: {
      accepted: toBoolean(validation.accepted, false),
      reasons: Array.isArray(validation.reasons) ? validation.reasons.map((item) => String(item)) : [],
      liveEligible: toBoolean(validation.liveEligible, false),
      liveBlockedReasons: Array.isArray(validation.liveBlockedReasons) ? validation.liveBlockedReasons.map((item) => String(item)) : [],
    },
  };
}

function sanitizeCycle(value: unknown): SelfLearningV5CycleSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = String(candidate.id || "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    timestampIso: String(candidate.timestampIso || new Date().toISOString()),
    summary: String(candidate.summary || ""),
    bestStrategyId: candidate.bestStrategyId == null ? null : String(candidate.bestStrategyId),
    acceptedVariants: Math.max(0, Math.round(toFiniteNumber(candidate.acceptedVariants, 0))),
    liveBlocked: toBoolean(candidate.liveBlocked, true),
  };
}

function sanitizeRegistryObservation(value: unknown): SelfLearningV5RegistryObservation {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    candidateStrategyId: candidate.candidateStrategyId == null ? null : String(candidate.candidateStrategyId),
    requiredShadowCycles: Math.max(1, Math.round(toFiniteNumber(candidate.requiredShadowCycles, 3))),
    requiredObservationHours: Math.max(1, toFiniteNumber(candidate.requiredObservationHours, 6)),
    observedShadowCycles: Math.max(0, Math.round(toFiniteNumber(candidate.observedShadowCycles, 0))),
    observedObservationHours: Math.max(0, toFiniteNumber(candidate.observedObservationHours, 0)),
    eligibleForPromotion: toBoolean(candidate.eligibleForPromotion, false),
    firstObservedAt: typeof candidate.firstObservedAt === "string" ? candidate.firstObservedAt : null,
    lastObservedAt: typeof candidate.lastObservedAt === "string" ? candidate.lastObservedAt : null,
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons.map((item) => String(item)) : [],
  };
}

function sanitizePromotionAudit(value: unknown): SelfLearningV5PromotionAudit | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const strategyId = String(candidate.strategyId || "").trim();
  if (!strategyId) {
    return null;
  }
  const observation = candidate.observation && typeof candidate.observation === "object"
    ? candidate.observation as Record<string, unknown>
    : {};
  return {
    strategyId,
    promotedAt: String(candidate.promotedAt || new Date().toISOString()),
    promotedBy: String(candidate.promotedBy || "unknown"),
    rationale: String(candidate.rationale || "manual_shadow_to_live"),
    fromStatus: String(candidate.fromStatus || "shadow"),
    toStatus: "live",
    observation: {
      requiredShadowCycles: Math.max(1, Math.round(toFiniteNumber(observation.requiredShadowCycles, 3))),
      requiredObservationHours: Math.max(1, toFiniteNumber(observation.requiredObservationHours, 6)),
      observedShadowCycles: Math.max(0, Math.round(toFiniteNumber(observation.observedShadowCycles, 0))),
      observedObservationHours: Math.max(0, toFiniteNumber(observation.observedObservationHours, 0)),
    },
  };
}

function sanitizeState(value: unknown): SelfLearningV5State | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const scope = sanitizeScope({
    accountId: candidate.accountId,
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
  });
  if (!scope) {
    return null;
  }

  const snapshot = candidate.snapshot && typeof candidate.snapshot === "object" ? candidate.snapshot as Record<string, unknown> : {};
  const dataset = snapshot.dataset && typeof snapshot.dataset === "object" ? snapshot.dataset as Record<string, unknown> : {};
  const optimizer = snapshot.optimizer && typeof snapshot.optimizer === "object" ? snapshot.optimizer as Record<string, unknown> : {};
  const validation = snapshot.validation && typeof snapshot.validation === "object" ? snapshot.validation as Record<string, unknown> : {};
  const thresholds = validation.thresholds && typeof validation.thresholds === "object" ? validation.thresholds as Record<string, unknown> : {};
  const registry = snapshot.registry && typeof snapshot.registry === "object" ? snapshot.registry as Record<string, unknown> : {};
  const registryEntries = Array.isArray(registry.entries) ? registry.entries : [];
  const promotionAuditTrailRaw = Array.isArray(registry.promotionAuditTrail) ? registry.promotionAuditTrail : [];
  const datasetPreviewRaw = Array.isArray(snapshot.datasetPreview) ? snapshot.datasetPreview : [];
  const cyclesRaw = Array.isArray(candidate.cycles) ? candidate.cycles : [];

  return {
    version: Math.max(1, Math.round(toFiniteNumber(candidate.version, SELF_LEARNING_V5_VERSION))),
    accountId: scope.accountId,
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    enabled: toBoolean(candidate.enabled, true),
    strictValidation: toBoolean(candidate.strictValidation, true),
    allowLiveDeployment: toBoolean(candidate.allowLiveDeployment, false),
    modelUpdatedAt: typeof candidate.modelUpdatedAt === "string" ? candidate.modelUpdatedAt : null,
    snapshot: {
      dataset: {
        sampleSize: Math.max(0, Math.round(toFiniteNumber(dataset.sampleSize, 0))),
        successRatePct: toFiniteNumber(dataset.successRatePct, 0),
        avgPnl: toFiniteNumber(dataset.avgPnl, 0),
        lastFrameAt: typeof dataset.lastFrameAt === "string" ? dataset.lastFrameAt : null,
        featureCoveragePct: toFiniteNumber(dataset.featureCoveragePct, 0),
      },
      optimizer: {
        runId: String(optimizer.runId || ""),
        ranAt: String(optimizer.ranAt || new Date().toISOString()),
        generatedVariants: Math.max(0, Math.round(toFiniteNumber(optimizer.generatedVariants, 0))),
        evaluatedVariants: Math.max(0, Math.round(toFiniteNumber(optimizer.evaluatedVariants, 0))),
        acceptedVariants: Math.max(0, Math.round(toFiniteNumber(optimizer.acceptedVariants, 0))),
        rejectedVariants: Math.max(0, Math.round(toFiniteNumber(optimizer.rejectedVariants, 0))),
        bestStrategyId: optimizer.bestStrategyId == null ? null : String(optimizer.bestStrategyId),
        bestScore: toFiniteNumber(optimizer.bestScore, 0),
      },
      validation: {
        strict: toBoolean(validation.strict, true),
        thresholds: {
          minWinratePct: toFiniteNumber(thresholds.minWinratePct, 55),
          maxDrawdownPct: toFiniteNumber(thresholds.maxDrawdownPct, 8),
          minSharpe: toFiniteNumber(thresholds.minSharpe, 1.2),
          maxOverfitGapPct: toFiniteNumber(thresholds.maxOverfitGapPct, 12),
          minTrades: Math.max(1, Math.round(toFiniteNumber(thresholds.minTrades, 12))),
        },
        liveBlocked: toBoolean(validation.liveBlocked, true),
        liveBlockReasons: Array.isArray(validation.liveBlockReasons) ? validation.liveBlockReasons.map((item) => String(item)) : [],
      },
      registry: {
        activeShadowStrategyId: registry.activeShadowStrategyId == null ? null : String(registry.activeShadowStrategyId),
        activeLiveStrategyId: registry.activeLiveStrategyId == null ? null : String(registry.activeLiveStrategyId),
        observation: sanitizeRegistryObservation(registry.observation),
        promotionAuditTrail: promotionAuditTrailRaw
          .map((item) => sanitizePromotionAudit(item))
          .filter((item): item is SelfLearningV5PromotionAudit => Boolean(item))
          .slice(0, 24),
        entries: registryEntries
          .map((item) => sanitizeRegistryEntry(item))
          .filter((item): item is SelfLearningV5RegistryEntry => Boolean(item))
          .slice(0, 24),
      },
      datasetPreview: datasetPreviewRaw
        .map((item) => sanitizeFrame(item))
        .filter((item): item is SelfLearningV5Frame => Boolean(item))
        .slice(0, 40),
    },
    cycles: cyclesRaw
      .map((item) => sanitizeCycle(item))
      .filter((item): item is SelfLearningV5CycleSummary => Boolean(item))
      .slice(0, 40),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  };
}

function getStateFilePath(scope: SelfLearningV5Scope): string {
  const accountDir = safeSegment(scope.accountId, "default");
  const symbol = safeSegment(scope.symbol, "symbol");
  const timeframe = safeSegment(scope.timeframe, "tf");
  return path.join(SELF_LEARNING_V5_BASE_DIR, accountDir, `${symbol}__${timeframe}.json`);
}

export function parseSelfLearningV5Scope(value: unknown): SelfLearningV5Scope | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return sanitizeScope(value as Partial<SelfLearningV5Scope>);
}

export async function readSelfLearningV5State(scope: SelfLearningV5Scope): Promise<SelfLearningV5State | null> {
  const filePath = getStateFilePath(scope);
  try {
    const raw = await readFile(filePath, "utf8");
    return sanitizeState(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeSelfLearningV5State(value: unknown): Promise<SelfLearningV5State> {
  const sanitized = sanitizeState(value);
  if (!sanitized) {
    throw new Error("invalid_self_learning_v5_state");
  }

  const normalized: SelfLearningV5State = {
    ...sanitized,
    version: SELF_LEARNING_V5_VERSION,
    updatedAt: new Date().toISOString(),
  };

  const filePath = getStateFilePath(normalized);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function listSelfLearningV5Scopes(filters?: {
  accountId?: string;
  symbol?: string;
  timeframe?: string;
  limit?: number;
}): Promise<SelfLearningV5ScopeSummary[]> {
  const accountFilter = String(filters?.accountId || "").trim();
  const symbolFilter = String(filters?.symbol || "").trim().toUpperCase();
  const timeframeFilter = String(filters?.timeframe || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(filters?.limit || 120)));

  const summaries: SelfLearningV5ScopeSummary[] = [];
  let accountDirs: string[] = [];
  try {
    accountDirs = (await readdir(SELF_LEARNING_V5_BASE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  for (const accountDir of accountDirs) {
    if (accountFilter && accountDir !== safeSegment(accountFilter, "default")) {
      continue;
    }
    const accountPath = path.join(SELF_LEARNING_V5_BASE_DIR, accountDir);
    const files = (await readdir(accountPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    for (const fileName of files) {
      const filePath = path.join(accountPath, fileName);
      const raw = await readFile(filePath, "utf8").catch(() => "");
      if (!raw) {
        continue;
      }
      let parsedJson: unknown = null;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        parsedJson = null;
      }
      const parsed = sanitizeState(parsedJson);
      if (!parsed) {
        continue;
      }
      if (symbolFilter && parsed.symbol.toUpperCase() !== symbolFilter) {
        continue;
      }
      if (timeframeFilter && parsed.timeframe.toLowerCase() !== timeframeFilter) {
        continue;
      }
      summaries.push({
        accountId: parsed.accountId,
        symbol: parsed.symbol,
        timeframe: parsed.timeframe,
        updatedAt: parsed.updatedAt,
        cycleCount: parsed.cycles.length,
        registryCount: parsed.snapshot.registry.entries.length,
        enabled: parsed.enabled,
        strictValidation: parsed.strictValidation,
        liveBlocked: parsed.snapshot.validation.liveBlocked,
      });
      if (summaries.length >= limit * 2) {
        break;
      }
    }
    if (summaries.length >= limit * 2) {
      break;
    }
  }

  return summaries
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}