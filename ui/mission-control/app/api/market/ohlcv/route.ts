import { NextRequest, NextResponse } from "next/server";

import { fallbackOhlcv, hasUsableRows } from "../../../../lib/binanceMarketFallback";
import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../lib/controlPlane";
import { getCachedOhlcv, setCachedOhlcv } from "../../../../lib/ohlcvCache";
import { normalizeOhlcvRows, type NormalizedOhlcvBar } from "../../../../lib/ohlcvIntegrity";

type CanonicalOhlcvBar = NormalizedOhlcvBar;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const instrument = request.nextUrl.searchParams.get("instrument") || "BTCUSDT";
  const venue = request.nextUrl.searchParams.get("venue") || "binance-public";
  const timeframe = request.nextUrl.searchParams.get("timeframe") || "1m";
  const limit = Number(request.nextUrl.searchParams.get("limit") || "500");

  // Serve from cache when available (20s TTL — keeps data fresh but avoids hammering upstream).
  const cached = getCachedOhlcv(instrument, timeframe);
  if (cached && cached.length >= Math.min(limit, cached.length)) {
    return NextResponse.json(cached.slice(-limit), {
      status: 200,
      headers: { "X-Data-Source": "cache", "X-Data-Contract": "ohlcv-v1" },
    });
  }

  try {
    const { response, payload } = await cpFetchJsonSafe(`/v1/market/ohlcv?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&timeframe=${encodeURIComponent(timeframe)}&limit=${encodeURIComponent(String(limit))}`, {
      headers: extractMcContextHeaders(request),
    });
    if (response.ok && hasUsableRows(payload)) {
      const rows = Array.isArray(payload) ? payload : (((payload as { rows?: unknown[] } | null)?.rows) ?? []);
      const normalized = normalizeOhlcvRows(rows, { instrument, venue, timeframe }) as CanonicalOhlcvBar[];
      setCachedOhlcv(instrument, timeframe, normalized);
      return NextResponse.json(normalized, {
        status: response.status,
        headers: { "X-Data-Contract": "ohlcv-v1" },
      });
    }
  } catch {
    // Fall through to market fallback.
  }

  const fallback = await fallbackOhlcv(instrument, timeframe, limit);
  const normalizedFallback = normalizeOhlcvRows(fallback, { instrument, venue, timeframe }) as CanonicalOhlcvBar[];
  if (normalizedFallback.length > 0) {
    setCachedOhlcv(instrument, timeframe, normalizedFallback);
    return NextResponse.json(normalizedFallback, {
      status: 200,
      headers: {
        "X-Data-Source": "fallback-binance",
        "X-Data-Contract": "ohlcv-v1",
      },
    });
  }

  return NextResponse.json([], {
    status: 503,
    headers: {
      "X-Data-Source": "canonical-unavailable",
      "X-Data-Contract": "ohlcv-v1",
    },
  });
}
