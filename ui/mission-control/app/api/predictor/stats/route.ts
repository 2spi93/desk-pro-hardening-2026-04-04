import { NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, withControlPlaneNetwork } from "../../../../lib/controlPlane";
import { predictorFetchJsonSafe } from "../../../../lib/predictorFetch";

export async function GET(): Promise<NextResponse> {
  const { response, payload: body, network, retryPolicy } = await predictorFetchJsonSafe(
    "/stats",
    { method: "GET" },
    { allowRetry: true, routeKey: "/predictor/stats" },
  );
  const surfaceStatus = network.degraded_flag || response.status >= 500 ? 200 : response.status;
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: surfaceStatus });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, retryPolicy);
  return nextResponse;
}
