import { NextResponse } from "next/server";

import {
  classifyControlPlaneNetworkRegime,
  computeControlPlaneInfraHealth,
  getControlPlaneNetworkMetricsSnapshot,
} from "../../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const networkMetrics = getControlPlaneNetworkMetricsSnapshot();
  const infraHealth = computeControlPlaneInfraHealth(networkMetrics);
  const networkRegime = classifyControlPlaneNetworkRegime(networkMetrics, infraHealth);

  return NextResponse.json(
    {
      network_metrics: networkMetrics,
      infra_health: infraHealth,
      network_regime: networkRegime,
      generated_at: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    },
  );
}