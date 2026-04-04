import { NextRequest, NextResponse } from "next/server";

import { fallbackDepth, hasUsableObject } from "../../../../../lib/binanceMarketFallback";
import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const instrument = request.nextUrl.searchParams.get("instrument") || "BTCUSDT";
  const venue = request.nextUrl.searchParams.get("venue") || "binance-public";

  try {
    const { response, payload } = await cpFetchJsonSafe(`/v1/market/orderbook/depth?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}`, {
      headers: extractMcContextHeaders(request),
    });
    if (response.ok && hasUsableObject(payload)) {
      return NextResponse.json(payload, { status: response.status });
    }
  } catch {
    // Fall through to market fallback.
  }

  const fallback = await fallbackDepth(instrument);
  if (!fallback) {
    return NextResponse.json({ detail: "market_depth_unavailable" }, { status: 503 });
  }

  return NextResponse.json(fallback, {
    status: 200,
    headers: {
      "X-Data-Source": "fallback-binance",
    },
  });
}
