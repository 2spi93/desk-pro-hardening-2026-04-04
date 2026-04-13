import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../../lib/apiAuth";
import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function POST(): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const { response, payload } = await cpFetchJsonSafe("/v1/system/kill-switch/reset", { method: "POST" });
  return NextResponse.json(payload, { status: response.status });
}
