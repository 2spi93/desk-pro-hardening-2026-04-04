import { NextRequest, NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, cpFetchJsonSafe, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../../../lib/controlPlane";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const headers = extractMcContextHeaders(request);
  const { response, payload: body, network } = await cpFetchJsonSafe("/v1/ai/kairos/shadow/stop", {
    method: "POST",
    headers,
  });
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, response.headers.get("x-mc-control-plane-retry-policy") || undefined);
  return nextResponse;
}
