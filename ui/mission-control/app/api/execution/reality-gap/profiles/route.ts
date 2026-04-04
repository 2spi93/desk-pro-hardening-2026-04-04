import { NextRequest, NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, cpFetchJsonSafe, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limit = request.nextUrl.searchParams.get("limit") || "50";
  const { response, payload, network } = await cpFetchJsonSafe(`/v1/execution/reality-gap/profiles?limit=${encodeURIComponent(limit)}`, {
    headers: extractMcContextHeaders(request),
  });
  const nextResponse = NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, response.headers.get("x-mc-control-plane-retry-policy") || undefined);
  return nextResponse;
}