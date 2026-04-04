import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit") || "30";
  const { response, payload } = await cpFetchJsonSafe(`/v1/ai/history?limit=${encodeURIComponent(limit)}`);
  return NextResponse.json(payload, { status: response.status });
}
