import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const { response, payload } = await cpFetchJsonSafe("/v1/ai/local-models/health");
  return NextResponse.json(payload, { status: response.status });
}
