import { NextResponse } from "next/server";

import { cpFetchJsonSafe, getControlPlaneNetworkMetricsSnapshot } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  try {
    const [healthResult, capacityResult, providersResult] = await Promise.all([
      cpFetchJsonSafe("/v1/ai/health"),
      cpFetchJsonSafe("/v1/ai/capacity"),
      cpFetchJsonSafe("/v1/ai/providers"),
    ]);

    const degraded = !healthResult.response.ok || !capacityResult.response.ok || !providersResult.response.ok;
    return NextResponse.json(
      {
        health: healthResult.payload,
        capacity: capacityResult.payload,
        providers: providersResult.payload,
        degraded,
        upstream: {
          health: healthResult.response.status,
          capacity: capacityResult.response.status,
          providers: providersResult.response.status,
        },
        network: {
          health: healthResult.network,
          capacity: capacityResult.network,
          providers: providersResult.network,
        },
        network_state: degraded ? "degraded" : "healthy",
        degraded_flag: degraded,
        network_metrics: getControlPlaneNetworkMetricsSnapshot(),
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
        health: { status: "unavailable" },
        capacity: { status: "unavailable" },
        providers: [],
        degraded: true,
        detail: "ai_health_unreachable",
        network_state: "degraded",
        degraded_flag: true,
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
