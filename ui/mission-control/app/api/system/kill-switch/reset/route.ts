import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function POST(): Promise<NextResponse> {
  const { response, payload } = await cpFetchJsonSafe("/v1/system/kill-switch/reset", { method: "POST" });
  return NextResponse.json(payload, { status: response.status });
}
