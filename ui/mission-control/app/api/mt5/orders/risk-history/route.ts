import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";
import { executeWithShadowMode, shadowResponse } from "../../../../../lib/shadowMode";

const SHADOW_CONFIG = {
  route: "mt5/orders/risk-history",
  enabled: true,
  shadowOnly: true,           // Phase 1: test backend, return fallback
  dualMode: false,
  rolloutPercentage: 0,       // 0% = nobody gets real data yet
};

function generateFallback() {
  return [];
}

function normalizeRiskHistoryShadowShape(payload: unknown): Record<string, unknown> {
  return {
    is_array: Array.isArray(payload),
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limit = request.nextUrl.searchParams.get("limit") || "50";
  const symbol = request.nextUrl.searchParams.get("symbol") || "";
  const accountId = request.nextUrl.searchParams.get("account_id") || "";
  const fromTs = request.nextUrl.searchParams.get("from") || "";
  const toTs = request.nextUrl.searchParams.get("to") || "";
  
  // Extract userId from Bearer token
  const authHeader = request.headers.get("authorization");
  const userId = authHeader?.split(" ")[1]?.substring(0, 16) || undefined;

  const params = new URLSearchParams();
  params.set("limit", limit);
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
        const { response, payload } = await cpFetchJsonSafe(`/v1/mt5/orders/risk-history?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return payload;
      },
      getFallback: generateFallback,
      normalizeForComparison: (payload) => normalizeRiskHistoryShadowShape(payload),
    }
  );

  return shadowResponse(result, 200);
}
