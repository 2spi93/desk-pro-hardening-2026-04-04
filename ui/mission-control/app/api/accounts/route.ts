import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../lib/controlPlane";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  const path = query ? `/v1/accounts?${query}` : "/v1/accounts";
  const { response, payload } = await cpFetchJsonSafe(path);
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => ({}));
  const { response, payload } = await cpFetchJsonSafe("/v1/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return NextResponse.json(payload, { status: response.status });
}