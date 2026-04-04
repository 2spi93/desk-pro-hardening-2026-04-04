import { NextResponse } from "next/server";

import { cpFetchJsonSafe, getControlPlaneNetworkMetricsSnapshot, withControlPlaneNetwork } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  try {
    const { response, payload, network } = await cpFetchJsonSafe("/v1/live-readiness/overview");
    return NextResponse.json(
      {
        ...withControlPlaneNetwork(payload, network),
        degraded: !response.ok,
        upstream_status: response.status,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        degraded: true,
        upstream_status: 0,
        detail: "live_readiness_unreachable",
        network_metrics: getControlPlaneNetworkMetricsSnapshot(),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  }
}
