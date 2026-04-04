import { NextRequest, NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../../lib/controlPlane";
import { predictorFetchJsonSafe } from "../../../../../lib/predictorFetch";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const payload = await request.json().catch(() => ({}));
  const headers = extractMcContextHeaders(request);
  headers.set("Content-Type", "application/json");
  const { response, payload: body, network, retryPolicy } = await predictorFetchJsonSafe(
    "/brain/learn",
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    },
    { allowRetry: false, routeKey: "/predictor/brain/learn" },
  );
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, retryPolicy);
  return nextResponse;
}