import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  try {
    const { response, payload } = await cpFetchJsonSafe("/v1/mt5/health");
    return NextResponse.json(
      {
        ...((typeof payload === "object" && payload !== null) ? payload : { payload }),
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
        detail: "mt5_health_unreachable",
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
