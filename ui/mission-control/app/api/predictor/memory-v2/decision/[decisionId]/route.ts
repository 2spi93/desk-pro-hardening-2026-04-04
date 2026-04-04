import { NextRequest, NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, cpFetchJsonSafe, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../../../lib/controlPlane";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ decisionId: string }> },
): Promise<NextResponse> {
  const resolved = await params;
  const { response, payload, network } = await cpFetchJsonSafe(`/v1/predictor/memory-v2/decision/${encodeURIComponent(resolved.decisionId)}`, {
    headers: extractMcContextHeaders(request),
  });
  const nextResponse = NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, response.headers.get("x-mc-control-plane-retry-policy") || undefined);
  return nextResponse;
}