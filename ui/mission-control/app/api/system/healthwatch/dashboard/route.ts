import { NextResponse } from "next/server";

import { readHealthwatchDashboard } from "../../../../../lib/healthwatchDashboard";

export async function GET(): Promise<NextResponse> {
  const payload = await readHealthwatchDashboard();
  if (!payload) {
    return NextResponse.json({
      available: false,
      detail: "healthwatch_dashboard_unavailable",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}