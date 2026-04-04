import { NextResponse } from "next/server";

import { readHealthwatchDashboard } from "../../../../lib/healthwatchDashboard";

export async function GET(): Promise<NextResponse> {
  try {
    const payload = await readHealthwatchDashboard();
    if (!payload) {
      throw new Error("public_chart_health_unavailable");
    }

    return NextResponse.json(
      {
        available: true,
        generated_at: payload.generated_at ?? null,
        public_chart_visibility: payload.public_chart_visibility ?? null,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        available: false,
        detail: "public_chart_health_unavailable",
        public_chart_visibility: null,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}