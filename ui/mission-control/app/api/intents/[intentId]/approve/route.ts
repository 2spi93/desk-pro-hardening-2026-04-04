import { NextResponse } from "next/server";

import { cpFetch } from "../../../../../lib/controlPlane";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> }
): Promise<NextResponse> {
  const resolved = await params;
  const response = await cpFetch(`/v1/intents/${resolved.intentId}/approve/server-signed`, {
    method: "POST",
  });

  if (!response.ok) {
    return NextResponse.redirect(new URL("/?approve_error=1", request.url));
  }
  return NextResponse.redirect(new URL("/", request.url));
}
