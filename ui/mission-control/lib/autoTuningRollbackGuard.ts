import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type RollbackGuardWeight = {
  strategyId: string;
  pct: number;
};

export type RollbackGuardObservation = {
  timestampIso: string;
  currentHealth: number;
  currentBrier: number | null;
  healthDrop: number;
  brierRise: number;
  degradeHealth: boolean;
  degradeBrier: boolean;
  shouldProposeRollback: boolean;
};

export type RollbackGuardSessionRecord = {
  id: string;
  startedAtIso: string;
  baselineHealth: number;
  baselineBrier: number | null;
  baselineWeights: RollbackGuardWeight[];
  windowMin: number;
  healthDropThreshold: number;
  brierRiseThreshold: number;
  source: string;
  reason: string;
  status: "active" | "closed";
  closeReason?: string;
  closedAtIso?: string;
  observations: RollbackGuardObservation[];
};

type GuardState = {
  activeSession: RollbackGuardSessionRecord | null;
  history: RollbackGuardSessionRecord[];
};

const ROLLBACK_GUARD_DIR = process.env.AUTO_TUNING_ROLLBACK_GUARD_DIR || "/tmp";
const ROLLBACK_GUARD_FILE = process.env.AUTO_TUNING_ROLLBACK_GUARD_FILE || "mission-control-auto-tuning-rollback-guard.json";

function filePath(): string {
  return path.join(ROLLBACK_GUARD_DIR, ROLLBACK_GUARD_FILE);
}

async function readState(): Promise<GuardState> {
  try {
    const content = await readFile(filePath(), "utf-8");
    const parsed = JSON.parse(content) as Partial<GuardState>;
    return {
      activeSession: parsed.activeSession || null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return {
      activeSession: null,
      history: [],
    };
  }
}

async function writeState(state: GuardState): Promise<void> {
  await mkdir(path.dirname(filePath()), { recursive: true });
  await writeFile(
    filePath(),
    JSON.stringify({
      activeSession: state.activeSession,
      history: state.history.slice(-80),
    }),
    "utf-8",
  );
}

function isExpired(session: RollbackGuardSessionRecord): boolean {
  const startedAt = new Date(session.startedAtIso).getTime();
  if (!Number.isFinite(startedAt) || session.windowMin <= 0) return false;
  return Date.now() - startedAt >= session.windowMin * 60_000;
}

async function expireActiveIfNeeded(state: GuardState): Promise<GuardState> {
  if (!state.activeSession || state.activeSession.status !== "active") {
    return state;
  }
  if (!isExpired(state.activeSession)) {
    return state;
  }
  const closed: RollbackGuardSessionRecord = {
    ...state.activeSession,
    status: "closed",
    closeReason: "expired_backend_policy",
    closedAtIso: new Date().toISOString(),
  };
  state.activeSession = null;
  state.history.push(closed);
  await writeState(state);
  return state;
}

export async function getRollbackGuardState(limit = 20): Promise<GuardState> {
  const state = await expireActiveIfNeeded(await readState());
  return {
    activeSession: state.activeSession,
    history: state.history.slice(-Math.max(1, limit)).reverse(),
  };
}

export async function startRollbackGuardSession(session: RollbackGuardSessionRecord): Promise<void> {
  const state = await readState();
  const next: RollbackGuardSessionRecord = {
    ...session,
    status: "active",
    observations: session.observations.slice(-120),
  };
  state.activeSession = next;
  state.history.push(next);
  await writeState(state);
}

export async function closeRollbackGuardSession(reason: string): Promise<RollbackGuardSessionRecord | null> {
  const state = await expireActiveIfNeeded(await readState());
  if (!state.activeSession) {
    return null;
  }
  const closed: RollbackGuardSessionRecord = {
    ...state.activeSession,
    status: "closed",
    closeReason: reason,
    closedAtIso: new Date().toISOString(),
  };
  state.activeSession = null;
  state.history.push(closed);
  await writeState(state);
  return closed;
}

export async function appendRollbackGuardObservation(obs: RollbackGuardObservation): Promise<RollbackGuardSessionRecord | null> {
  const state = await expireActiveIfNeeded(await readState());
  if (!state.activeSession) {
    return null;
  }
  const updated: RollbackGuardSessionRecord = {
    ...state.activeSession,
    observations: [...state.activeSession.observations, obs].slice(-120),
  };
  state.activeSession = updated;
  state.history.push(updated);
  await writeState(state);
  return updated;
}