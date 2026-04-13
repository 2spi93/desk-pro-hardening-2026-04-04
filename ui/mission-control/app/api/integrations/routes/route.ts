import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const { response, payload } = await cpFetchJsonSafe("/v1/integrations/routes");
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => ({}));
  const { response, payload } = await cpFetchJsonSafe("/v1/integrations/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return NextResponse.json(payload, { status: response.status });
}