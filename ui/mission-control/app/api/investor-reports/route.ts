import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../lib/controlPlane";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = request.nextUrl.searchParams.toString();
  const path = `/v1/investor-reports${query ? `?${query}` : ""}`;
  const { response, payload } = await cpFetchJsonSafe(path, {
    headers: extractMcContextHeaders(request),
  });
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();
  const { response, payload } = await cpFetchJsonSafe("/v1/investor-reports", {
    method: "POST",
    headers: new Headers({
      ...Object.fromEntries(extractMcContextHeaders(request).entries()),
      "content-type": request.headers.get("content-type") || "application/json",
    }),
    body,
  });
  return NextResponse.json(payload, { status: response.status });
}
