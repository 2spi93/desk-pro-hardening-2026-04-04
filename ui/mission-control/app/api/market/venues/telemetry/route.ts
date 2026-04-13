import { NextResponse } from "next/server";

import { cpFetchJsonSafe, withControlPlaneNetwork } from "../../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const { response, payload, network } = await cpFetchJsonSafe("/v1/market/venues/telemetry");
  return NextResponse.json(withControlPlaneNetwork(payload, network, { includeMetrics: false }), { status: response.status });
}