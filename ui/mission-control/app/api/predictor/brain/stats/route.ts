import { NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, withControlPlaneNetwork } from "../../../../../lib/controlPlane";
import { predictorFetchJsonSafe } from "../../../../../lib/predictorFetch";

export async function GET(): Promise<NextResponse> {
  const { response, payload: body, network, retryPolicy } = await predictorFetchJsonSafe(
    "/brain/stats",
    { method: "GET" },
    { allowRetry: true, routeKey: "/predictor/brain/stats" },
  );
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, retryPolicy);
  return nextResponse;
}