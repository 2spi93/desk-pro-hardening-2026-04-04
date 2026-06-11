import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../lib/apiAuth";
import { buildRuntimeTruthSnapshot } from "../../../../lib/runtimeTruth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authError = await requireControlPlaneSession(request, { allowServiceProbe: true });
  if (authError) {
    return authError;
  }

  const symbol = request.nextUrl.searchParams.get("symbol") || "DESK";
  const marketInstrument = request.nextUrl.searchParams.get("marketInstrument")
    || request.nextUrl.searchParams.get("instrument")
    || "BTCUSDT";
  const timeframe = request.nextUrl.searchParams.get("timeframe") || "live";
  const strategy = request.nextUrl.searchParams.get("strategy") || "live-ops";
  const bypassCache = request.nextUrl.searchParams.get("bypassCache") === "1"
    || ["1", "true", "yes"].includes(String(request.nextUrl.searchParams.get("fresh") || "").toLowerCase());

  const snapshot = await buildRuntimeTruthSnapshot({
    symbol,
    marketInstrument,
    timeframe,
    strategy,
    bypassCache,
  });

  return NextResponse.json(snapshot, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Runtime-Truth-Verdict": snapshot.verdict,
    },
  });
}