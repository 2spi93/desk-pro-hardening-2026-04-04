import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../lib/apiAuth";
import { buildCanaryStatus } from "../../../../lib/canaryStatus";

export const dynamic = "force-dynamic";

// Read-only status of the one-shot SELL proof-renewal canary. Never mutates a
// marker, never triggers execution.
export async function GET(request: Request): Promise<NextResponse> {
  const unauthorized = await requireControlPlaneSession(request);
  if (unauthorized) {
    return unauthorized;
  }
  try {
    const snapshot = await buildCanaryStatus();
    return NextResponse.json(snapshot, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: "canary_status_unavailable", detail: String(error).slice(0, 200) },
      { status: 500 },
    );
  }
}
