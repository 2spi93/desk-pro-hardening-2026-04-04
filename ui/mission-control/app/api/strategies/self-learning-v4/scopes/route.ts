import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";
import { listSelfLearningV4Scopes } from "../../../../../lib/selfLearningV4Store";

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
  const accountId = String(url.searchParams.get("account_id") || "").trim();
  const symbol = String(url.searchParams.get("symbol") || "").trim();
  const timeframe = String(url.searchParams.get("timeframe") || "").trim();
  const limitRaw = Number(url.searchParams.get("limit") || 120);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.round(limitRaw) : 120));

  try {
    const params = new URLSearchParams();
    if (accountId) {
      params.set("account_id", accountId);
    }
    if (symbol) {
      params.set("symbol", symbol);
    }
    if (timeframe) {
      params.set("timeframe", timeframe);
    }
    params.set("limit", String(limit));

    const { response: cpResponse, payload } = await cpFetchJsonSafe(`/v1/strategies/self-learning-v4/scopes?${params.toString()}`, { method: "GET" });
    if (cpResponse.ok) {
      const items = Array.isArray((payload as { items?: unknown })?.items)
        ? (((payload as { items?: unknown[] }).items) || [])
        : [];
      return noStoreJson({
        status: "ok",
        items,
        total: Number((payload as { total?: unknown })?.total || 0),
        storage: "control-plane",
      }, 200);
    }
    if (cpResponse.status === 400) {
      const detail = (payload as { detail?: unknown })?.detail;
      return noStoreJson({ status: "error", message: typeof detail === "string" ? detail : "upstream_error" }, 400);
    }
    if (cpResponse.status === 401 || cpResponse.status === 403) {
      const items = await listSelfLearningV4Scopes({ accountId, symbol, timeframe, limit }).catch(() => []);
      return noStoreJson({
        status: "ok",
        items,
        total: items.length,
        storage: "local-fallback",
        degraded: true,
        detail: "self_learning_v4_scopes_anonymous_degraded",
        upstream_status: cpResponse.status,
      }, 200);
    }

    const items = await listSelfLearningV4Scopes({ accountId, symbol, timeframe, limit });
    return noStoreJson({ status: "ok", items, total: items.length, storage: "local-fallback" }, 200);
  } catch {
    return noStoreJson({
      status: "ok",
      items: [],
      total: 0,
      storage: "local-fallback",
      degraded: true,
      detail: "self_learning_v4_scopes_unreachable",
    }, 200);
  }
}
