import { NextResponse } from "next/server";

import { fallbackQuotes, hasUsableRows } from "../../../../lib/binanceMarketFallback";
import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  try {
    const { response, payload } = await cpFetchJsonSafe("/v1/market/quotes");
    if (response.ok && hasUsableRows(payload)) {
      return NextResponse.json(payload, { status: response.status });
    }
  } catch {
    // Fall through to market fallback.
  }

  const fallback = await fallbackQuotes();
  return NextResponse.json(fallback, {
    status: 200,
    headers: {
      "X-Data-Source": "fallback-binance",
    },
  });
}