import { NextRequest, NextResponse } from "next/server";

import { getControlPlaneToken } from "../../../../lib/controlPlane";
import { appendV2RiskJournalEntry, readV2RiskJournalEntries } from "../../../../lib/v2RiskJournal";

function unauthorized(): NextResponse {
  return NextResponse.json({ message: "Authentication required" }, { status: 401 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = await getControlPlaneToken();
  if (!token) {
    return unauthorized();
  }

  const symbol = request.nextUrl.searchParams.get("symbol") || "";
  const timeframe = request.nextUrl.searchParams.get("timeframe") || "";
  const strategy = request.nextUrl.searchParams.get("strategy") || "";
  const limit = Number(request.nextUrl.searchParams.get("limit") || 40);

  const entries = await readV2RiskJournalEntries({ symbol, timeframe, strategy, limit });
  return NextResponse.json({ entries });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = await getControlPlaneToken();
  if (!token) {
    return unauthorized();
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const timeframe = String(body.timeframe || "").trim();
  const strategy = String(body.strategy || "").trim();
  const action = String(body.action || "").trim();
  const detail = String(body.detail || "").trim();
  const meta = (body.meta && typeof body.meta === "object") ? (body.meta as Record<string, unknown>) : undefined;

  if (!symbol || !timeframe || !strategy || !action || !detail) {
    return NextResponse.json({ message: "symbol, timeframe, strategy, action and detail are required" }, { status: 400 });
  }

  const entry = {
    id: `v2risk-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
    createdAtIso: new Date().toISOString(),
    symbol,
    timeframe,
    strategy,
    action,
    detail,
    meta,
  };

  await appendV2RiskJournalEntry(entry);
  return NextResponse.json({ ok: true, entry });
}
