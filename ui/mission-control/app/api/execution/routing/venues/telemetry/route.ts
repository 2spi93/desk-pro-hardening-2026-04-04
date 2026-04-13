import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe, withControlPlaneNetwork } from "../../../../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const lookbackMinutes = Number.parseInt(request.nextUrl.searchParams.get("lookback_minutes") || "240", 10);
  const clampedLookbackMinutes = Number.isFinite(lookbackMinutes)
    ? Math.min(Math.max(lookbackMinutes, 5), 1440)
    : 240;
  const { response, payload, network } = await cpFetchJsonSafe(`/v1/routes/venues/telemetry?lookback_minutes=${clampedLookbackMinutes}`);
  return NextResponse.json(withControlPlaneNetwork(payload, network, { includeMetrics: false }), { status: response.status });
}