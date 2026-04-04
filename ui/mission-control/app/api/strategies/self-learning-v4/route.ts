import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";
import {
  parseSelfLearningV4Scope,
  readSelfLearningV4State,
  writeSelfLearningV4State,
} from "../../../../lib/selfLearningV4Store";

const READ_CACHE_TTL_MS = 1200;

type ReadCacheEntry = {
  atMs: number;
  payload: {
    status: string;
    state: unknown;
    updatedAt: string | null;
    storage: string;
    degraded?: boolean;
    detail?: string;
    upstream_status?: number;
  };
};

const selfLearningGlobal = globalThis as typeof globalThis & {
  __mcSelfLearningV4ReadCache?: Map<string, ReadCacheEntry>;
};

const readCache = selfLearningGlobal.__mcSelfLearningV4ReadCache || new Map<string, ReadCacheEntry>();
if (!selfLearningGlobal.__mcSelfLearningV4ReadCache) {
  selfLearningGlobal.__mcSelfLearningV4ReadCache = readCache;
}

function noStoreJson(payload: unknown, status = 200): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scope = parseSelfLearningV4Scope({
    accountId: url.searchParams.get("account_id"),
    symbol: url.searchParams.get("symbol"),
    timeframe: url.searchParams.get("timeframe"),
  });
  if (!scope) {
    return noStoreJson({ status: "error", message: "account_id, symbol and timeframe are required" }, 400);
  }

  const cacheKey = `${scope.accountId}::${scope.symbol}::${scope.timeframe}`;
  const nowMs = Date.now();
  const cached = readCache.get(cacheKey);
  if (cached && nowMs - cached.atMs <= READ_CACHE_TTL_MS) {
    return noStoreJson(cached.payload, 200);
  }

  try {
    const { response: cpResponse, payload } = await cpFetchJsonSafe(
      `/v1/strategies/self-learning-v4?account_id=${encodeURIComponent(scope.accountId)}&symbol=${encodeURIComponent(scope.symbol)}&timeframe=${encodeURIComponent(scope.timeframe)}`,
      { method: "GET" },
    );
    if (cpResponse.ok) {
      const safePayload = (payload && typeof payload === "object") ? (payload as Record<string, unknown>) : {};
      const normalized = {
        status: "ok",
        state: safePayload.state ?? null,
        updatedAt: typeof safePayload.updated_at === "string" ? safePayload.updated_at : null,
        storage: "control-plane",
      };
      readCache.set(cacheKey, { atMs: nowMs, payload: normalized });
      return noStoreJson(normalized, 200);
    }
    if (cpResponse.status === 400) {
      const safePayload = (payload && typeof payload === "object") ? (payload as Record<string, unknown>) : {};
      const detail = typeof safePayload.detail === "string" ? safePayload.detail : "upstream_error";
      return noStoreJson({ status: "error", message: detail }, cpResponse.status);
    }

    if (cpResponse.status === 401 || cpResponse.status === 403) {
      const state = await readSelfLearningV4State(scope).catch(() => null);
      const normalized = {
        status: "ok",
        state,
        updatedAt: state?.updatedAt || null,
        storage: "local-fallback",
        degraded: true,
        detail: "self_learning_v4_anonymous_degraded",
        upstream_status: cpResponse.status,
      };
      readCache.set(cacheKey, { atMs: nowMs, payload: normalized });
      return noStoreJson(normalized, 200);
    }

    const state = await readSelfLearningV4State(scope);
    const normalized = { status: "ok", state, updatedAt: state?.updatedAt || null, storage: "local-fallback" };
    readCache.set(cacheKey, { atMs: nowMs, payload: normalized });
    return noStoreJson(normalized, 200);
  } catch {
    const normalized = {
      status: "ok",
      state: null,
      updatedAt: null,
      storage: "local-fallback",
      degraded: true,
      detail: "self_learning_v4_unreachable",
    };
    readCache.set(cacheKey, { atMs: nowMs, payload: normalized });
    return noStoreJson(normalized, 200);
  }
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return noStoreJson({ status: "error", message: "invalid payload" }, 400);
  }

  try {
    const { response: cpResponse, payload } = await cpFetchJsonSafe("/v1/strategies/self-learning-v4", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (cpResponse.ok) {
      const safePayload = (payload && typeof payload === "object") ? (payload as Record<string, unknown>) : {};
      return noStoreJson({
        status: "ok",
        state: safePayload.state ?? null,
        updatedAt: typeof safePayload.updated_at === "string" ? safePayload.updated_at : null,
        storage: "control-plane",
      }, 200);
    }
    if (cpResponse.status === 400 || cpResponse.status === 401 || cpResponse.status === 403) {
      const safePayload = (payload && typeof payload === "object") ? (payload as Record<string, unknown>) : {};
      const detail = typeof safePayload.detail === "string" ? safePayload.detail : "upstream_error";
      return noStoreJson({ status: "error", message: detail }, cpResponse.status);
    }

    const state = await writeSelfLearningV4State(body);
    return noStoreJson({ status: "ok", state, updatedAt: state.updatedAt, storage: "local-fallback" }, 200);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_self_learning_v4_state") {
      return noStoreJson({ status: "error", message: "invalid self-learning v4 state" }, 400);
    }
    return noStoreJson(
      {
        status: "ok",
        state: null,
        updatedAt: null,
        storage: "local-fallback",
        degraded: true,
        detail: "self_learning_v4_persist_unreachable",
      },
      200,
    );
  }
}