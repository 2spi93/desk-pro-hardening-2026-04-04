import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketKey: string }> }
): Promise<NextResponse> {
  const resolved = await params;
  const body = await request.json();
  const { response, payload } = await cpFetchJsonSafe(`/v1/incidents/${resolved.ticketKey}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return NextResponse.json(payload, { status: response.status });
}
