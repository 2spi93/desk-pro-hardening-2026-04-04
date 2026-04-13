import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../lib/apiAuth";
import { cpFetchJsonSafe, withControlPlaneNetwork } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const { response, payload, network } = await cpFetchJsonSafe("/v1/system/config");
  return NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const body = await request.json().catch(() => ({}));
  const { response, payload, network } = await cpFetchJsonSafe("/v1/system/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
}