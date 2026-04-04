import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ strategyId: string }> }
): Promise<NextResponse> {
  const resolved = await params;
  const { response } = await cpFetchJsonSafe(`/v1/strategies/${resolved.strategyId}/resume`, {
    method: "POST",
  });
  if (!response.ok) {
    return NextResponse.redirect(new URL("/live-readiness?resume_error=1", request.url));
  }
  return NextResponse.redirect(new URL("/live-readiness?resumed=1", request.url));
}
