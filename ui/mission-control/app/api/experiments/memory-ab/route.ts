import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const windowHours = Number(searchParams.get("window_hours") || 168);
  const safeWindow = Math.max(24, Math.min(24 * 30, windowHours));
  const { response, payload } = await cpFetchJsonSafe(`/v1/experiments/memory-ab?window_hours=${safeWindow}`);
  return NextResponse.json(payload, { status: response.status });
}
