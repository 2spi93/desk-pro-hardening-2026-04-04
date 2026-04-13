import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../../lib/apiAuth";
import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../../lib/controlPlane";

type JsonMap = Record<string, unknown>;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" ? value as JsonMap : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function POST(request: Request): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const forwardedHeaders = extractMcContextHeaders(request);
  const raw = asObject(await request.json());
  const body = {
    provider: asString(raw.provider, "bingx"),
    account_id: asString(raw.account_id),
    symbol: asString(raw.symbol),
    side: asString(raw.side, "buy") === "sell" ? "sell" : "buy",
    order_id: asString(raw.order_id),
    client_order_id: asString(raw.client_order_id),
    notional_usd: asNumber(raw.notional_usd),
  };

  const { response, payload } = await cpFetchJsonSafe("/v1/live/orders/cancel", {
    method: "POST",
    headers: {
      ...Object.fromEntries(forwardedHeaders.entries()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return NextResponse.json(asObject(payload), { status: response.status });
}