import { NextResponse } from "next/server";

import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../lib/controlPlane";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json();
  const forwardedHeaders = extractMcContextHeaders(request);
  forwardedHeaders.set("Content-Type", "application/json");
  const { response, payload } = await cpFetchJsonSafe("/v1/ai/execute", {
    method: "POST",
    headers: forwardedHeaders,
    body: JSON.stringify(body),
  });
  return NextResponse.json(payload, { status: response.status });
}
