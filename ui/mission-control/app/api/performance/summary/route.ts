import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = request.nextUrl.searchParams.toString();
  const path = `/v1/performance/summary${query ? `?${query}` : ""}`;
  const { response, payload, network } = await cpFetchJsonSafe(path, {
    headers: extractMcContextHeaders(request),
  });
  return NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
}
