import { NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, withControlPlaneNetwork } from "../../../../../../lib/controlPlane";
import { predictorFetchJsonSafe } from "../../../../../../lib/predictorFetch";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();
  const path = query ? `/brain/calibration/history?${query}` : "/brain/calibration/history";
  const { response, payload: body, network, retryPolicy } = await predictorFetchJsonSafe(
    path,
    { method: "GET" },
    { allowRetry: true, routeKey: "/predictor/brain/calibration/history" },
  );
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, retryPolicy);
  return nextResponse;
}