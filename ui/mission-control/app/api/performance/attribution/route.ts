import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = request.nextUrl.searchParams.toString();
  const path = `/v1/performance/attribution${query ? `?${query}` : ""}`;
  const { response, payload } = await cpFetchJsonSafe(path, {
    headers: extractMcContextHeaders(request),
  });
  return NextResponse.json(payload, { status: response.status });
}
