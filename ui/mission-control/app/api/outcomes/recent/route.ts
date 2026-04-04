import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") || "50";
  const { response, payload } = await cpFetchJsonSafe(`/v1/outcomes/recent?limit=${encodeURIComponent(limit)}`);
  return NextResponse.json(payload, { status: response.status });
}
