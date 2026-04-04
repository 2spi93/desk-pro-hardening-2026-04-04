import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

const SELF_LEARNING_V4_VERSION = 1;
const SELF_LEARNING_V4_BASE_DIR = process.env.MC_SELF_LEARNING_V4_DIR
  || path.resolve(process.cwd(), "../../data/mission-control/self-learning-v4");

export type SelfLearningV4Weights = {
  dom: number;
  footprint: number;
  liquidity: number;
  "price-action": number;
};

export type SelfLearningV4Scenario = "continuation" | "reversal" | "balance";
export type SelfLearningV4Regime = "trend" | "chop" | "volatile";
export type SelfLearningV4RegimeFilter = "all" | SelfLearningV4Regime;
export type SelfLearningV4ScenarioFilter = "all" | SelfLearningV4Scenario;

export type SelfLearningV4JournalEvent = {
  id: string;
  timestampIso: string;
  symbol: string;
  timeframe: string;
  regime: SelfLearningV4Regime;
  scenario: SelfLearningV4Scenario;
  outcome: "win" | "loss";
  pnl: number;
  mfe: number;
  mae: number;
  weights: SelfLearningV4Weights;
};

export type SelfLearningV4ProfileSnapshot = {
  sampleSize: number;
  scopeLabel: string;
  winratePct: number;
  learnedWeights: SelfLearningV4Weights;
};

export type SelfLearningV4DriftSnapshot = {
  status: "WARMUP" | "STABLE" | "DRIFT";
  shortSamples: number;
  longSamples: number;
  shortWinratePct: number;
  longWinratePct: number;
  winrateDropPct: number;
  shortBrier: number | null;
  longBrier: number | null;
  brierRise: number;
  shortLossCount: number;
  enoughSamples: boolean;
  shouldDemote: boolean;
  signature: string;
};

export type SelfLearningV4Snapshot = {
  regime: SelfLearningV4Regime;
  scenarioHint: SelfLearningV4Scenario;
  active: boolean;
  profile: SelfLearningV4ProfileSnapshot;
  adaptiveWeights: SelfLearningV4Weights;
  effectiveWeights: SelfLearningV4Weights;
  drift: SelfLearningV4DriftSnapshot;
};

export type SelfLearningV4State = {
  version: number;
  accountId: string;
  symbol: string;
  timeframe: string;
  enabled: boolean;
  autoAdaptEnabled: boolean;
  modelUpdatedAt: string | null;
  driftAutoDemotedAt: string | null;
  filters: {
    regime: SelfLearningV4RegimeFilter;
    scenario: SelfLearningV4ScenarioFilter;
  };
  snapshot: SelfLearningV4Snapshot;
  journal: SelfLearningV4JournalEvent[];
  updatedAt: string;
};

export type SelfLearningV4Scope = {
  accountId: string;
  symbol: string;
  timeframe: string;
};

export type SelfLearningV4ScopeSummary = {
  accountId: string;
  symbol: string;
  timeframe: string;
  updatedAt: string;
  journalSize: number;
  enabled: boolean;
  autoAdaptEnabled: boolean;
  driftStatus: "WARMUP" | "STABLE" | "DRIFT";
};

function safeSegment(value: string, fallback: string): string {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96);
  return normalized || fallback;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isScenario(value: unknown): value is SelfLearningV4Scenario {
  return value === "continuation" || value === "reversal" || value === "balance";
}

function isRegime(value: unknown): value is SelfLearningV4Regime {
  return value === "trend" || value === "chop" || value === "volatile";
}

function isRegimeFilter(value: unknown): value is SelfLearningV4RegimeFilter {
  return value === "all" || isRegime(value);
}

function isScenarioFilter(value: unknown): value is SelfLearningV4ScenarioFilter {
  return value === "all" || isScenario(value);
}

function sanitizeWeights(value: unknown): SelfLearningV4Weights {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    dom: toFiniteNumber(candidate.dom, 1),
    footprint: toFiniteNumber(candidate.footprint, 1),
    liquidity: toFiniteNumber(candidate.liquidity, 1),
    "price-action": toFiniteNumber(candidate["price-action"], 1),
  };
}

function sanitizeScope(scope: { accountId?: unknown; symbol?: unknown; timeframe?: unknown } | null | undefined): SelfLearningV4Scope | null {
  if (!scope) {
    return null;
  }
  const accountId = String(scope.accountId || "").trim();
  const symbol = String(scope.symbol || "").trim();
  const timeframe = String(scope.timeframe || "").trim();
  if (!accountId || !symbol || !timeframe) {
    return null;
  }
  return { accountId, symbol, timeframe };
}

function sanitizeJournalEvent(value: unknown): SelfLearningV4JournalEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = String(candidate.id || "").trim();
  const timestampIso = String(candidate.timestampIso || "").trim();
  const symbol = String(candidate.symbol || "").trim();
  const timeframe = String(candidate.timeframe || "").trim();
  const outcome = candidate.outcome === "win" ? "win" : candidate.outcome === "loss" ? "loss" : null;
  if (!id || !timestampIso || !symbol || !timeframe || !outcome || !isRegime(candidate.regime) || !isScenario(candidate.scenario)) {
    return null;
  }
  return {
    id,
    timestampIso,
    symbol,
    timeframe,
    regime: candidate.regime,
    scenario: candidate.scenario,
    outcome,
    pnl: toFiniteNumber(candidate.pnl, 0),
    mfe: toFiniteNumber(candidate.mfe, 0),
    mae: toFiniteNumber(candidate.mae, 0),
    weights: sanitizeWeights(candidate.weights),
  };
}

function sanitizeProfile(value: unknown): SelfLearningV4ProfileSnapshot {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    sampleSize: Math.max(0, Math.round(toFiniteNumber(candidate.sampleSize, 0))),
    scopeLabel: String(candidate.scopeLabel || ""),
    winratePct: toFiniteNumber(candidate.winratePct, 50),
    learnedWeights: sanitizeWeights(candidate.learnedWeights),
  };
}

function sanitizeDrift(value: unknown): SelfLearningV4DriftSnapshot {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = candidate.status === "DRIFT" || candidate.status === "STABLE" ? candidate.status : "WARMUP";
  return {
    status,
    shortSamples: Math.max(0, Math.round(toFiniteNumber(candidate.shortSamples, 0))),
    longSamples: Math.max(0, Math.round(toFiniteNumber(candidate.longSamples, 0))),
    shortWinratePct: toFiniteNumber(candidate.shortWinratePct, 0),
    longWinratePct: toFiniteNumber(candidate.longWinratePct, 0),
    winrateDropPct: toFiniteNumber(candidate.winrateDropPct, 0),
    shortBrier: candidate.shortBrier == null ? null : toFiniteNumber(candidate.shortBrier, 0),
    longBrier: candidate.longBrier == null ? null : toFiniteNumber(candidate.longBrier, 0),
    brierRise: toFiniteNumber(candidate.brierRise, 0),
    shortLossCount: Math.max(0, Math.round(toFiniteNumber(candidate.shortLossCount, 0))),
    enoughSamples: Boolean(candidate.enoughSamples),
    shouldDemote: Boolean(candidate.shouldDemote),
    signature: String(candidate.signature || ""),
  };
}

function sanitizeSnapshot(value: unknown): SelfLearningV4Snapshot {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    regime: isRegime(candidate.regime) ? candidate.regime : "chop",
    scenarioHint: isScenario(candidate.scenarioHint) ? candidate.scenarioHint : "balance",
    active: Boolean(candidate.active),
    profile: sanitizeProfile(candidate.profile),
    adaptiveWeights: sanitizeWeights(candidate.adaptiveWeights),
    effectiveWeights: sanitizeWeights(candidate.effectiveWeights),
    drift: sanitizeDrift(candidate.drift),
  };
}

function sanitizeState(value: unknown): SelfLearningV4State | null {
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

  const rawJournal = Array.isArray(candidate.journal) ? candidate.journal : [];
  const journal = rawJournal
    .map((item) => sanitizeJournalEvent(item))
    .filter((item): item is SelfLearningV4JournalEvent => Boolean(item))
    .filter((item) => item.symbol === scope.symbol && item.timeframe === scope.timeframe)
    .sort((a, b) => Date.parse(b.timestampIso) - Date.parse(a.timestampIso));

  const uniqueJournal: SelfLearningV4JournalEvent[] = [];
  const seenIds = new Set<string>();
  for (const item of journal) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    uniqueJournal.push(item);
    if (uniqueJournal.length >= 240) {
      break;
    }
  }

  const filtersCandidate = candidate.filters && typeof candidate.filters === "object"
    ? candidate.filters as Record<string, unknown>
    : {};

  return {
    version: SELF_LEARNING_V4_VERSION,
    accountId: scope.accountId,
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    enabled: Boolean(candidate.enabled),
    autoAdaptEnabled: Boolean(candidate.autoAdaptEnabled),
    modelUpdatedAt: typeof candidate.modelUpdatedAt === "string" ? candidate.modelUpdatedAt : null,
    driftAutoDemotedAt: typeof candidate.driftAutoDemotedAt === "string" ? candidate.driftAutoDemotedAt : null,
    filters: {
      regime: isRegimeFilter(filtersCandidate.regime) ? filtersCandidate.regime : "all",
      scenario: isScenarioFilter(filtersCandidate.scenario) ? filtersCandidate.scenario : "all",
    },
    snapshot: sanitizeSnapshot(candidate.snapshot),
    journal: uniqueJournal,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  };
}

function getStateFilePath(scope: SelfLearningV4Scope): string {
  const accountDir = safeSegment(scope.accountId, "default");
  const symbol = safeSegment(scope.symbol, "symbol");
  const timeframe = safeSegment(scope.timeframe, "tf");
  return path.join(SELF_LEARNING_V4_BASE_DIR, accountDir, `${symbol}__${timeframe}.json`);
}

export function parseSelfLearningV4Scope(value: unknown): SelfLearningV4Scope | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return sanitizeScope(value as Partial<SelfLearningV4Scope>);
}

export async function readSelfLearningV4State(scope: SelfLearningV4Scope): Promise<SelfLearningV4State | null> {
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

export async function writeSelfLearningV4State(value: unknown): Promise<SelfLearningV4State> {
  const sanitized = sanitizeState(value);
  if (!sanitized) {
    throw new Error("invalid_self_learning_v4_state");
  }

  const normalized: SelfLearningV4State = {
    ...sanitized,
    version: SELF_LEARNING_V4_VERSION,
    updatedAt: new Date().toISOString(),
  };

  const filePath = getStateFilePath(normalized);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function listSelfLearningV4Scopes(filters?: {
  accountId?: string;
  symbol?: string;
  timeframe?: string;
  limit?: number;
}): Promise<SelfLearningV4ScopeSummary[]> {
  const accountFilter = String(filters?.accountId || "").trim();
  const symbolFilter = String(filters?.symbol || "").trim().toUpperCase();
  const timeframeFilter = String(filters?.timeframe || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(filters?.limit || 120)));

  const summaries: SelfLearningV4ScopeSummary[] = [];
  let accountDirs: string[] = [];
  try {
    accountDirs = (await readdir(SELF_LEARNING_V4_BASE_DIR, { withFileTypes: true }))
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
    const accountPath = path.join(SELF_LEARNING_V4_BASE_DIR, accountDir);
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
        journalSize: parsed.journal.length,
        enabled: parsed.enabled,
        autoAdaptEnabled: parsed.autoAdaptEnabled,
        driftStatus: parsed.snapshot.drift.status,
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