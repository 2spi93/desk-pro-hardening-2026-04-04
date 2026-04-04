import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../../lib/controlPlane";

export async function POST(
  _: Request,
  { params }: { params: Promise<{ approvalId: string }> },
): Promise<NextResponse> {
  const resolved = await params;
  const { response, payload } = await cpFetchJsonSafe(`/v1/mt5/orders/live-approve/${resolved.approvalId}`, {
    method: "POST",
  });
  return NextResponse.json(payload, { status: response.status });
}
