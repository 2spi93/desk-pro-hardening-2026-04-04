import { NextRequest, NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, cpFetchJsonSafe, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limitRaw = Number.parseInt(request.nextUrl.searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 20;
  const headers = extractMcContextHeaders(request);
  const { response, payload: body, network } = await cpFetchJsonSafe(`/v1/ai/kairos/shadow/cycles?limit=${limit}`, {
    method: "GET",
    headers,
  });
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, response.headers.get("x-mc-control-plane-retry-policy") || undefined);
  return nextResponse;
}
