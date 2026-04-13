import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../lib/apiAuth";
import { cpFetchJsonSafe, withControlPlaneNetwork } from "../../../../lib/controlPlane";

export async function POST(request: Request): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const body = await request.json().catch(() => ({}));
  const reason = String((body as Record<string, unknown>).reason || "ui_emergency_stop").trim() || "ui_emergency_stop";
  const source = String((body as Record<string, unknown>).source || "mission-control-live-ops").trim() || "mission-control-live-ops";

  const [killSwitchResult, kairosStopResult] = await Promise.all([
    cpFetchJsonSafe("/v1/system/kill-switch/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        reason,
        system_mode: "suggest",
        payload: {
          cancel_all_orders_requested: true,
          flatten_all_positions_requested: true,
          disable_live_routing_requested: true,
          trigger: "emergency_stop_button",
        },
      }),
    }),
    cpFetchJsonSafe("/v1/ai/kairos/shadow/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, reason }),
    }),
  ]);

  return NextResponse.json(
    withControlPlaneNetwork(
      {
        status: killSwitchResult.response.ok ? "stopped" : "degraded",
        kill_switch: killSwitchResult.payload,
        kairos_shadow: kairosStopResult.payload,
        requested_effects: {
          cancel_all_orders: true,
          flatten_all_positions: true,
          disable_live_routing: true,
        },
      },
      killSwitchResult.network,
    ),
    { status: killSwitchResult.response.status },
  );
}