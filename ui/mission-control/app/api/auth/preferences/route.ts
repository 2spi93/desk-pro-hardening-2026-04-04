import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";
import { executeWithShadowMode, shadowResponse } from "../../../../lib/shadowMode";

const SHADOW_CONFIG_GET = {
  route: "auth/preferences",
  enabled: true,
  shadowOnly: true,           // Phase 1: test backend, return fallback
  dualMode: false,
  rolloutPercentage: 0,       // 0% = nobody gets real data yet
};

const SHADOW_CONFIG_PUT = {
  route: "auth/preferences",
  enabled: true,
  shadowOnly: true,
  dualMode: false,
  rolloutPercentage: 0,
};

const PREFS_GET_BURST_WINDOW_MS = 2000;
const PREFS_GET_BURST_MAX = 12;
const PREFS_GET_CACHE_TTL_MS = 1500;
const PREFS_GUARD_MAX_KEYS = 512;

type PreferencesGuardState = {
  windowStartMs: number;
  countInWindow: number;
  lastPayload: unknown | null;
  lastPayloadAtMs: number;
};

const prefsGetGuardBySession = new Map<string, PreferencesGuardState>();

function trimPrefsGuardStore(nowMs: number): void {
  if (prefsGetGuardBySession.size <= PREFS_GUARD_MAX_KEYS) {
    return;
  }
  const staleBefore = nowMs - Math.max(PREFS_GET_BURST_WINDOW_MS, PREFS_GET_CACHE_TTL_MS) * 4;
  for (const [key, state] of prefsGetGuardBySession.entries()) {
    if (state.lastPayloadAtMs < staleBefore) {
      prefsGetGuardBySession.delete(key);
    }
    if (prefsGetGuardBySession.size <= PREFS_GUARD_MAX_KEYS) {
      break;
    }
  }
}

function toSessionKey(request: Request): string {
  const cookie = request.headers.get("cookie") || "";
  const tokenMatch = cookie.match(/(?:^|;\s*)mc_token=([^;]+)/);
  if (tokenMatch?.[1]) {
    return `cookie:${tokenMatch[1].slice(0, 24)}`;
  }
  const authHeader = request.headers.get("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return `bearer:${authHeader.slice(7, 31)}`;
  }
  const forwarded = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "anon";
  return `ip:${forwarded.split(",")[0].trim().slice(0, 64)}`;
}

function getOrCreateGuardState(sessionKey: string, nowMs: number): PreferencesGuardState {
  const existing = prefsGetGuardBySession.get(sessionKey);
  if (existing) {
    if (nowMs - existing.windowStartMs > PREFS_GET_BURST_WINDOW_MS) {
      existing.windowStartMs = nowMs;
      existing.countInWindow = 0;
    }
    return existing;
  }
  const created: PreferencesGuardState = {
    windowStartMs: nowMs,
    countInWindow: 0,
    lastPayload: null,
    lastPayloadAtMs: 0,
  };
  prefsGetGuardBySession.set(sessionKey, created);
  trimPrefsGuardStore(nowMs);
  return created;
}

function buildThrottledHeaders(kind: "cache-hit" | "burst"): HeadersInit {
  return {
    "x-mc-prefs-guard": kind,
    "cache-control": "no-store",
  };
}

function generateFallback() {
  return {
    user_id: null,
    updated_at: null,
    preferences: {
      ui_mode: "novice",
      theme: "dark",
      chart: {
        type: "candles",
        timezone: "UTC",
        interval: "1m",
      },
      notifications: {
        risk_alert: true,
        execution_report: true,
        system_status: true,
      },
      defaults: {
        order_qty: 0.1,
        leverage: 1.0,
        slippage_tolerance_bps: 10,
      },
    },
  };
}

function normalizePreferencesGetShadowShape(payload: unknown): Record<string, unknown> {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const preferences = record.preferences && typeof record.preferences === "object"
    ? record.preferences as Record<string, unknown>
    : null;
  return {
    has_preferences_object: preferences !== null,
    updated_at_nullable: record.updated_at === null || typeof record.updated_at === "string",
  };
}

function normalizePreferencesPutShadowShape(payload: unknown): Record<string, unknown> {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const status = String(record.status || "").toLowerCase();
  return {
    acknowledged: status === "ok" || status === "updated",
    has_timestamp: typeof record.updated_at === "string" || typeof record.timestamp === "string" || record.updated_at === null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const nowMs = Date.now();
  const sessionKey = toSessionKey(request);
  const guard = getOrCreateGuardState(sessionKey, nowMs);
  guard.countInWindow += 1;

  if (guard.lastPayload && nowMs - guard.lastPayloadAtMs <= PREFS_GET_CACHE_TTL_MS) {
    return NextResponse.json(guard.lastPayload, { status: 200, headers: buildThrottledHeaders("cache-hit") });
  }

  if (guard.countInWindow > PREFS_GET_BURST_MAX) {
    return NextResponse.json(guard.lastPayload || generateFallback(), { status: 200, headers: buildThrottledHeaders("burst") });
  }

  // Extract userId from Bearer token for consistent rollout
  const authHeader = request.headers.get("authorization");
  const userId = authHeader?.split(" ")[1]?.substring(0, 16) || undefined;

  const result = await executeWithShadowMode(
    { ...SHADOW_CONFIG_GET, userId },
    {
      fetchBackend: async () => {
        const { response, payload } = await cpFetchJsonSafe("/v1/auth/preferences");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return payload;
      },
      getFallback: generateFallback,
      normalizeForComparison: (payload) => normalizePreferencesGetShadowShape(payload),
    }
  );

  const response = shadowResponse(result, 200);
  try {
    const payload = await response.clone().json();
    guard.lastPayload = payload;
    guard.lastPayloadAtMs = Date.now();
  } catch {
    // noop: keep route resilient even if upstream returns non-JSON
  }
  return response;
}

export async function PUT(request: Request): Promise<Response> {
  const body = await request.text();
  const authHeader = request.headers.get("authorization");
  const userId = authHeader?.split(" ")[1]?.substring(0, 16) || undefined;

  const result = await executeWithShadowMode(
    { ...SHADOW_CONFIG_PUT, userId },
    {
      fetchBackend: async () => {
        const { response, payload } = await cpFetchJsonSafe("/v1/auth/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return payload;
      },
      getFallback: () => ({
        status: "ok",
        persisted: false,
        timestamp: new Date().toISOString(),
      }),
      normalizeForComparison: (payload) => normalizePreferencesPutShadowShape(payload),
    }
  );

  return shadowResponse(result, 200);
}
