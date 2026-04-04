import { NextResponse } from "next/server";

import { appendAutoTuningAudit } from "../../../../../lib/autoTuningAudit";
import {
  appendRollbackGuardObservation,
  closeRollbackGuardSession,
  getRollbackGuardState,
  startRollbackGuardSession,
  type RollbackGuardSessionRecord,
} from "../../../../../lib/autoTuningRollbackGuard";
import { getControlPlaneToken } from "../../../../../lib/controlPlane";

function isEnabled(): boolean {
  const raw = String(process.env.AUTO_TUNING_WRITEBACK_ENABLED || "").toLowerCase();
  return raw === "1" || raw === "true";
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildSession(body: Record<string, unknown>): RollbackGuardSessionRecord | null {
  const session = (body.session || {}) as Record<string, unknown>;
  const id = String(session.id || `rg-${Date.now()}`);
  const startedAtIso = String(session.startedAtIso || new Date().toISOString());
  const baselineHealth = toNumber(session.baselineHealth, NaN);
  const baselineBrierRaw = session.baselineBrier;
  const baselineBrier = baselineBrierRaw == null ? null : toNumber(baselineBrierRaw, NaN);
  const windowMin = Math.max(10, Math.min(480, Math.round(toNumber(session.windowMin, 90))));
  const healthDropThreshold = Math.max(0.01, Math.min(0.5, toNumber(session.healthDropThreshold, 0.08)));
  const brierRiseThreshold = Math.max(0.005, Math.min(0.2, toNumber(session.brierRiseThreshold, 0.035)));
  const source = String(session.source || "mission-control-ui");
  const reason = String(session.reason || "writeback-apply");
  const baselineWeightsRaw = Array.isArray(session.baselineWeights) ? session.baselineWeights : [];
  const baselineWeights = baselineWeightsRaw
    .map((row) => {
      const r = (row || {}) as Record<string, unknown>;
      const strategyId = String(r.strategyId || "").trim();
      const pct = toNumber(r.pct, NaN);
      if (!strategyId || !Number.isFinite(pct)) return null;
      return { strategyId, pct: Math.max(0, Math.min(100, pct)) };
    })
    .filter((row): row is { strategyId: string; pct: number } => row !== null)
    .slice(0, 48);

  if (!Number.isFinite(baselineHealth) || baselineWeights.length === 0) {
    return null;
  }

  return {
    id,
    startedAtIso,
    baselineHealth,
    baselineBrier: baselineBrier !== null && !Number.isFinite(baselineBrier) ? null : baselineBrier,
    baselineWeights,
    windowMin,
    healthDropThreshold,
    brierRiseThreshold,
    source,
    reason,
    status: "active",
    observations: [],
  };
}

export async function GET(): Promise<NextResponse> {
  const state = await getRollbackGuardState(20);
  return NextResponse.json({
    enabled: isEnabled(),
    ...state,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isEnabled()) {
    return NextResponse.json({ message: "AUTO_TUNING_WRITEBACK_ENABLED is disabled" }, { status: 403 });
  }

  const token = await getControlPlaneToken();
  const actor = token ? "authenticated" : "anonymous";
  if (!token) {
    return NextResponse.json({ message: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = String((body as Record<string, unknown>).action || "").toLowerCase();

  if (action === "start") {
    const session = buildSession(body as Record<string, unknown>);
    if (!session) {
      return NextResponse.json({ message: "Invalid rollback guard session payload" }, { status: 400 });
    }
    await startRollbackGuardSession(session);
    await appendAutoTuningAudit({
      id: `rg-${Date.now()}`,
      timestampIso: new Date().toISOString(),
      actor,
      dryRun: false,
      status: "accepted",
      recommendationCount: session.baselineWeights.length,
      summary: "rollback_guard_started",
    });
    return NextResponse.json({ message: "Rollback guard session started", session });
  }

  if (action === "observe") {
    const observation = (body as Record<string, unknown>).observation as Record<string, unknown> | undefined;
    if (!observation) {
      return NextResponse.json({ message: "Missing observation payload" }, { status: 400 });
    }
    const currentBrierRaw = observation.currentBrier;
    const currentBrier =
      currentBrierRaw == null
        ? null
        : (() => {
          const n = Number(currentBrierRaw);
          return Number.isFinite(n) ? n : null;
        })();
    const updated = await appendRollbackGuardObservation({
      timestampIso: String(observation.timestampIso || new Date().toISOString()),
      currentHealth: toNumber(observation.currentHealth, 0),
      currentBrier,
      healthDrop: toNumber(observation.healthDrop, 0),
      brierRise: toNumber(observation.brierRise, 0),
      degradeHealth: Boolean(observation.degradeHealth),
      degradeBrier: Boolean(observation.degradeBrier),
      shouldProposeRollback: Boolean(observation.shouldProposeRollback),
    });
    if (!updated) {
      return NextResponse.json({ message: "No active rollback guard session" }, { status: 404 });
    }
    return NextResponse.json({ message: "Observation recorded", activeSession: updated });
  }

  if (action === "close") {
    const reason = String((body as Record<string, unknown>).reason || "manual-close");
    const closed = await closeRollbackGuardSession(reason);
    if (!closed) {
      return NextResponse.json({ message: "No active rollback guard session" }, { status: 404 });
    }
    await appendAutoTuningAudit({
      id: `rg-${Date.now()}`,
      timestampIso: new Date().toISOString(),
      actor,
      dryRun: false,
      status: "accepted",
      recommendationCount: closed.baselineWeights.length,
      summary: "rollback_guard_closed",
    });
    return NextResponse.json({ message: "Rollback guard session closed", session: closed });
  }

  return NextResponse.json({ message: "Unsupported action" }, { status: 400 });
}