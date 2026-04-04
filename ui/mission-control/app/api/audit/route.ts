import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limit = request.nextUrl.searchParams.get("limit") || "100";
  const { response, payload } = await cpFetchJsonSafe(`/v1/audit?limit=${encodeURIComponent(limit)}`);
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const { response, payload } = await cpFetchJsonSafe("/v1/audit/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return NextResponse.json(payload, { status: response.status });
}
