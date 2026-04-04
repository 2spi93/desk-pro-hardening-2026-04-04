import { NextRequest, NextResponse } from "next/server";

import {
  classifyControlPlaneNetworkRegime,
  computeControlPlaneInfraHealth,
  cpFetchJsonSafe,
  getControlPlaneNetworkMetricsSnapshot,
  withControlPlaneNetwork,
} from "../../../../../lib/controlPlane";

const ROUTING_RATE_WINDOW_MS = 2000;
const ROUTING_RATE_MAX = 5;
const ROUTING_RATE_MAX_VOLATILE = 20;
const ROUTING_CACHE_TTL_MS = 500;
const ROUTING_CACHE_TTL_MS_VOLATILE = 250;
const ROUTING_CB_FAIL_THRESHOLD = 4;
const ROUTING_CB_FAIL_WINDOW_MS = 5000;
const ROUTING_CB_OPEN_MS = 5000;
const ROUTING_GUARD_MAX_SESSIONS = 512;

type CachedRoutingPayload = {
  atMs: number;
  status: number;
  body: unknown;
};

type CircuitBreakerState = {
  openUntilMs: number;
  failCount: number;
  failWindowStartMs: number;
};

type SessionGuardState = {
  windowStartMs: number;
  requestCount: number;
  cacheBySymbol: Map<string, CachedRoutingPayload>;
  lastGoodBySymbol: Map<string, CachedRoutingPayload>;
  breakerBySymbol: Map<string, CircuitBreakerState>;
  lastSeenMs: number;
};

type RoutingRequestContext = {
  priorityExecution: boolean;
  fastChangingSignal: boolean;
  highVolatility: boolean;
  bypassCache: boolean;
  bypassRateLimit: boolean;
  bypassCircuitOpen: boolean;
  cacheTtlMs: number;
  rateLimitMax: number;
  schedulingProfile: "stable" | "degraded" | "critical";
};

const routingGuardGlobal = globalThis as typeof globalThis & {
  __mcRoutingScoreGuard?: Map<string, SessionGuardState>;
};

const routingGuardBySession = routingGuardGlobal.__mcRoutingScoreGuard || new Map<string, SessionGuardState>();
if (!routingGuardGlobal.__mcRoutingScoreGuard) {
  routingGuardGlobal.__mcRoutingScoreGuard = routingGuardBySession;
}

function normalizeSymbol(raw: string | null): string {
  const value = String(raw || "BTCUSDT").trim().toUpperCase();
  return value || "BTCUSDT";
}

function firstLower(value: string | null): string {
  return String(value || "").split(",")[0].trim().toLowerCase();
}

function isTruthyFlag(value: string | null): boolean {
  const normalized = firstLower(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function buildRequestContext(request: NextRequest): RoutingRequestContext {
  const requestType = firstLower(request.headers.get("x-mc-request-type") || request.nextUrl.searchParams.get("request_type"));
  const priority = firstLower(request.headers.get("x-mc-priority") || request.nextUrl.searchParams.get("priority"));
  const volatility = firstLower(request.headers.get("x-mc-market-volatility") || request.nextUrl.searchParams.get("volatility"));
  const signalState = firstLower(request.headers.get("x-mc-signal-state") || request.nextUrl.searchParams.get("signal_state"));

  const priorityExecution = requestType === "execution"
    || requestType === "ai"
    || priority === "high"
    || priority === "critical"
    || priority === "execution";

  const highVolatility = volatility === "high"
    || volatility === "spike"
    || volatility === "explosive"
    || signalState === "breakout"
    || signalState === "trap";

  const fastChangingSignal = highVolatility
    || signalState === "fast"
    || signalState === "reversal"
    || isTruthyFlag(request.headers.get("x-mc-fast-signal"))
    || isTruthyFlag(request.nextUrl.searchParams.get("fast_signal"));

  const bypassCache = priorityExecution || fastChangingSignal;
  return {
    priorityExecution,
    fastChangingSignal,
    highVolatility,
    bypassCache,
    bypassRateLimit: priorityExecution,
    bypassCircuitOpen: priorityExecution,
    cacheTtlMs: highVolatility ? ROUTING_CACHE_TTL_MS_VOLATILE : ROUTING_CACHE_TTL_MS,
    rateLimitMax: highVolatility ? ROUTING_RATE_MAX_VOLATILE : ROUTING_RATE_MAX,
    schedulingProfile: "stable",
  };
}

function applyInfraScheduling(
  context: RoutingRequestContext,
  networkRegime: "stable" | "degraded" | "critical",
): RoutingRequestContext {
  if (networkRegime === "stable") {
    return context;
  }
  if (networkRegime === "critical") {
    return {
      ...context,
      bypassCache: context.priorityExecution,
      bypassRateLimit: context.priorityExecution,
      cacheTtlMs: Math.max(context.cacheTtlMs * 4, ROUTING_CACHE_TTL_MS * 4),
      rateLimitMax: Math.max(1, Math.floor(context.rateLimitMax * 0.4)),
      schedulingProfile: "critical",
    };
  }
  return {
    ...context,
    bypassCache: context.priorityExecution,
    cacheTtlMs: Math.max(context.cacheTtlMs * 2, ROUTING_CACHE_TTL_MS * 2),
    rateLimitMax: Math.max(2, Math.floor(context.rateLimitMax * 0.6)),
    schedulingProfile: "degraded",
  };
}

function sessionKeyFromRequest(request: NextRequest): string {
  const cookieToken = request.cookies.get("mc_token")?.value
    || request.cookies.get("mc_token_compat")?.value
    || "";
  if (cookieToken) {
    return `cookie:${cookieToken.slice(0, 24)}`;
  }
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return `bearer:${auth.slice(7, 31)}`;
  }
  const forwarded = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "anon";
  return `ip:${forwarded.split(",")[0].trim().slice(0, 64)}`;
}

function trimSessionGuards(nowMs: number): void {
  if (routingGuardBySession.size <= ROUTING_GUARD_MAX_SESSIONS) {
    return;
  }
  const staleBefore = nowMs - 5 * Math.max(ROUTING_RATE_WINDOW_MS, ROUTING_CB_OPEN_MS, ROUTING_CACHE_TTL_MS);
  for (const [key, state] of routingGuardBySession.entries()) {
    if (state.lastSeenMs < staleBefore) {
      routingGuardBySession.delete(key);
    }
    if (routingGuardBySession.size <= ROUTING_GUARD_MAX_SESSIONS) {
      break;
    }
  }
}

function getOrCreateSessionGuard(sessionKey: string, nowMs: number): SessionGuardState {
  const existing = routingGuardBySession.get(sessionKey);
  if (existing) {
    if (nowMs - existing.windowStartMs > ROUTING_RATE_WINDOW_MS) {
      existing.windowStartMs = nowMs;
      existing.requestCount = 0;
    }
    existing.lastSeenMs = nowMs;
    return existing;
  }
  const created: SessionGuardState = {
    windowStartMs: nowMs,
    requestCount: 0,
    cacheBySymbol: new Map<string, CachedRoutingPayload>(),
    lastGoodBySymbol: new Map<string, CachedRoutingPayload>(),
    breakerBySymbol: new Map<string, CircuitBreakerState>(),
    lastSeenMs: nowMs,
  };
  routingGuardBySession.set(sessionKey, created);
  trimSessionGuards(nowMs);
  return created;
}

function readFreshCache(state: SessionGuardState, symbol: string, nowMs: number, ttlMs: number): CachedRoutingPayload | null {
  const cached = state.cacheBySymbol.get(symbol);
  if (!cached) {
    return null;
  }
  if (nowMs - cached.atMs > ttlMs) {
    return null;
  }
  return cached;
}

function readLastGood(state: SessionGuardState, symbol: string): CachedRoutingPayload | null {
  return state.lastGoodBySymbol.get(symbol) || null;
}

function setCache(state: SessionGuardState, symbol: string, status: number, body: unknown, nowMs: number): void {
  state.cacheBySymbol.set(symbol, {
    atMs: nowMs,
    status,
    body,
  });
  state.lastGoodBySymbol.set(symbol, {
    atMs: nowMs,
    status,
    body,
  });
  if (state.cacheBySymbol.size > 64) {
    for (const [key, value] of state.cacheBySymbol.entries()) {
      if (nowMs - value.atMs > ROUTING_CACHE_TTL_MS * 8) {
        state.cacheBySymbol.delete(key);
      }
      if (state.cacheBySymbol.size <= 48) {
        break;
      }
    }
  }
  if (state.lastGoodBySymbol.size > 64) {
    for (const [key, value] of state.lastGoodBySymbol.entries()) {
      if (nowMs - value.atMs > Math.max(ROUTING_CB_OPEN_MS * 6, 30_000)) {
        state.lastGoodBySymbol.delete(key);
      }
      if (state.lastGoodBySymbol.size <= 48) {
        break;
      }
    }
  }
}

function markUpstreamFailure(state: SessionGuardState, symbol: string, nowMs: number): void {
  const current = state.breakerBySymbol.get(symbol) || {
    openUntilMs: 0,
    failCount: 0,
    failWindowStartMs: nowMs,
  };
  if (nowMs - current.failWindowStartMs > ROUTING_CB_FAIL_WINDOW_MS) {
    current.failWindowStartMs = nowMs;
    current.failCount = 0;
  }
  current.failCount += 1;
  if (current.failCount >= ROUTING_CB_FAIL_THRESHOLD) {
    current.openUntilMs = nowMs + ROUTING_CB_OPEN_MS;
    current.failCount = 0;
    current.failWindowStartMs = nowMs;
  }
  state.breakerBySymbol.set(symbol, current);
}

function resetUpstreamFailure(state: SessionGuardState, symbol: string): void {
  state.breakerBySymbol.delete(symbol);
}

function parseJsonSafe<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function degradedRoutingScore(symbol: string, detail: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol,
    score: 0,
    confidence: 0,
    best: null,
    backup: null,
    routes: [],
    degraded: true,
    detail,
    failure_source: "infra",
    failure_reasons: [detail],
    failure_blocking: true,
    ...extra,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const nowMs = Date.now();
  const symbol = normalizeSymbol(request.nextUrl.searchParams.get("symbol"));
  const baseContext = buildRequestContext(request);
  const networkMetrics = getControlPlaneNetworkMetricsSnapshot();
  const infraHealth = computeControlPlaneInfraHealth(networkMetrics);
  const networkRegime = classifyControlPlaneNetworkRegime(networkMetrics, infraHealth);
  const context = applyInfraScheduling(baseContext, networkRegime);
  const guard = getOrCreateSessionGuard(sessionKeyFromRequest(request), nowMs);
  guard.requestCount += 1;

  const cached = context.bypassCache ? null : readFreshCache(guard, symbol, nowMs, context.cacheTtlMs);
  if (cached && !context.priorityExecution) {
    return NextResponse.json(cached.body, {
      status: cached.status,
      headers: {
        "x-mc-routing-guard": "cache-hit",
        "x-mc-routing-profile": context.highVolatility ? "volatile" : "normal",
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
        "cache-control": "no-store",
      },
    });
  }
  if (context.priorityExecution) {
    const liveHeader = cached ? "priority-bypass" : "priority-bypass";
    void liveHeader;
  }

  const breaker = guard.breakerBySymbol.get(symbol);
  if (!context.bypassCircuitOpen && breaker && breaker.openUntilMs > nowMs) {
    const fallback = readLastGood(guard, symbol);
    if (fallback) {
      return NextResponse.json(fallback.body, {
        status: fallback.status,
        headers: {
          "x-mc-routing-guard": "fallback-used",
          "x-mc-routing-fallback-source": "circuit-open",
          "x-mc-routing-fallback-age-ms": String(Math.max(0, nowMs - fallback.atMs)),
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      });
    }
    return NextResponse.json(
      degradedRoutingScore(symbol, "routing_score_circuit_open", {
        retry_after_ms: breaker.openUntilMs - nowMs,
      }),
      {
        status: 200,
        headers: {
          "x-mc-routing-guard": "circuit-open-degraded",
          "x-mc-routing-profile": context.highVolatility ? "volatile" : "normal",
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      },
    );
  }

  if (!context.bypassRateLimit && guard.requestCount > context.rateLimitMax) {
    const fallback = readLastGood(guard, symbol);
    if (fallback) {
      return NextResponse.json(fallback.body, {
        status: fallback.status,
        headers: {
          "x-mc-routing-guard": "fallback-used",
          "x-mc-routing-fallback-source": "rate-limited",
          "x-mc-routing-fallback-age-ms": String(Math.max(0, nowMs - fallback.atMs)),
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      });
    }
    return NextResponse.json(
      degradedRoutingScore(symbol, "routing_score_rate_limited", {
        window_ms: ROUTING_RATE_WINDOW_MS,
        max_requests: context.rateLimitMax,
      }),
      {
        status: 200,
        headers: {
          "x-mc-routing-guard": "rate-limited-degraded",
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      },
    );
  }

  try {
    const { response, payload, network } = await cpFetchJsonSafe(
      `/v1/execution/routing/score?symbol=${encodeURIComponent(symbol)}&infra_health=${encodeURIComponent(String(infraHealth))}&network_regime=${encodeURIComponent(networkRegime)}`,
    );
    const payloadMap = asObject(payload);
    const envelope = {
      ...withControlPlaneNetwork(payloadMap, network),
      infra_health: Number.isFinite(Number(payloadMap.infra_health)) ? Number(payloadMap.infra_health) : infraHealth,
      network_regime: String(payloadMap.network_regime || networkRegime),
    };

    if (response.ok) {
      setCache(guard, symbol, response.status, envelope, nowMs);
      resetUpstreamFailure(guard, symbol);
      return NextResponse.json(envelope, {
        status: response.status,
        headers: {
          "x-mc-routing-guard": context.priorityExecution ? "priority-bypass" : "live",
          "x-mc-routing-profile": context.highVolatility ? "volatile" : "normal",
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      });
    }

    if (response.status >= 500 || response.status === 429) {
      markUpstreamFailure(guard, symbol, nowMs);
    }
    const fallback = (response.status >= 500 || response.status === 429) ? readLastGood(guard, symbol) : null;
    if (fallback) {
      return NextResponse.json(fallback.body, {
        status: fallback.status,
        headers: {
          "x-mc-routing-guard": "fallback-used",
          "x-mc-routing-fallback-source": "upstream-error",
          "x-mc-routing-fallback-age-ms": String(Math.max(0, nowMs - fallback.atMs)),
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      });
    }
    return NextResponse.json(
      degradedRoutingScore(symbol, "routing_score_upstream_error", {
        upstream_status: response.status,
        upstream_payload: payload,
        network_metrics: networkMetrics,
        infra_health: infraHealth,
        network_regime: networkRegime,
      }),
      {
        status: 200,
        headers: {
          "x-mc-routing-guard": "live-error-degraded",
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    markUpstreamFailure(guard, symbol, nowMs);
    const fallback = readLastGood(guard, symbol);
    if (fallback) {
      return NextResponse.json(fallback.body, {
        status: fallback.status,
        headers: {
          "x-mc-routing-guard": "fallback-used",
          "x-mc-routing-fallback-source": "upstream-unreachable",
          "x-mc-routing-fallback-age-ms": String(Math.max(0, nowMs - fallback.atMs)),
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      });
    }
    return NextResponse.json(
      degradedRoutingScore(symbol, "routing_score_upstream_unreachable", {
        network_metrics: networkMetrics,
        infra_health: infraHealth,
        network_regime: networkRegime,
      }),
      {
        status: 200,
        headers: {
          "x-mc-routing-guard": "upstream-unreachable-degraded",
          "x-mc-routing-scheduler": context.schedulingProfile,
          "x-mc-routing-network-regime": networkRegime,
          "cache-control": "no-store",
        },
      },
    );
  }
}
