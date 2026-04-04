import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../../lib/controlPlane";
import { executeWithShadowMode, shadowResponse } from "../../../../../../lib/shadowMode";

const SHADOW_CONFIG = {
  route: "mt5/orders/risk-history/summary",
  enabled: true,
  shadowOnly: true,           // Phase 1: test backend, return fallback
  dualMode: false,
  rolloutPercentage: 0,       // 0% = nobody gets real data yet
};

function fallbackSummary(windowValue: string, missThreshold: string): Record<string, unknown> {
  const windowSize = Math.max(1, Number.parseInt(windowValue, 10) || 10);
  const threshold = Math.max(1, Number.parseInt(missThreshold, 10) || 3);
  return {
    count_ok: 0,
    count_miss: 0,
    last_block_reason: "none",
    window_size: windowSize,
    miss_in_window: 0,
    ratio_miss_window: 0,
    miss_threshold: threshold,
    alert: false,
  };
}

function normalizeRiskSummaryShadowShape(payload: unknown): Record<string, unknown> {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return {
    has_count_ok: typeof record.count_ok === "number",
    has_count_miss: typeof record.count_miss === "number",
    has_last_block_reason: typeof record.last_block_reason === "string",
    has_window_size: typeof record.window_size === "number",
    has_miss_in_window: typeof record.miss_in_window === "number",
    has_ratio_miss_window: typeof record.ratio_miss_window === "number",
    has_miss_threshold: typeof record.miss_threshold === "number",
    has_alert_flag: typeof record.alert === "boolean",
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const windowValue = request.nextUrl.searchParams.get("window") || "10";
  const missThreshold = request.nextUrl.searchParams.get("miss_threshold") || "3";
  const symbol = request.nextUrl.searchParams.get("symbol") || "";
  const accountId = request.nextUrl.searchParams.get("account_id") || "";
  const fromTs = request.nextUrl.searchParams.get("from") || "";
  const toTs = request.nextUrl.searchParams.get("to") || "";

  // Extract userId from Bearer token
  const authHeader = request.headers.get("authorization");
  const userId = authHeader?.split(" ")[1]?.substring(0, 16) || undefined;

  const params = new URLSearchParams();
  params.set("window", windowValue);
  params.set("miss_threshold", missThreshold);
  if (symbol.trim()) {
    params.set("symbol", symbol.trim());
  }
  if (accountId.trim()) {
    params.set("account_id", accountId.trim());
  }
  if (fromTs.trim()) {
    params.set("from_ts", fromTs.trim());
  }
  if (toTs.trim()) {
    params.set("to_ts", toTs.trim());
  }

  const result = await executeWithShadowMode(
    { ...SHADOW_CONFIG, userId },
    {
      fetchBackend: async () => {
        const { response, payload } = await cpFetchJsonSafe(`/v1/mt5/orders/risk-history/summary?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return payload;
      },
      getFallback: () => fallbackSummary(windowValue, missThreshold),
      normalizeForComparison: (payload) => normalizeRiskSummaryShadowShape(payload),
    }
  );

  return shadowResponse(result, 200);
}
