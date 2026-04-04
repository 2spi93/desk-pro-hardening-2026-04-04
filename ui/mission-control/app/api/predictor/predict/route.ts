import { NextRequest, NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../lib/controlPlane";
import { predictorFetchJsonSafe } from "../../../../lib/predictorFetch";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const payload = await request.json().catch(() => ({}));
  const headers = extractMcContextHeaders(request);
  headers.set("Content-Type", "application/json");
  const { response, payload: body, network, retryPolicy } = await predictorFetchJsonSafe(
    "/predict",
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    },
    { allowRetry: true, routeKey: "/predictor/predict" },
  );
  const surfaceStatus = network.degraded_flag || response.status >= 500 ? 200 : response.status;
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: surfaceStatus });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, retryPolicy);
  return nextResponse;
}
