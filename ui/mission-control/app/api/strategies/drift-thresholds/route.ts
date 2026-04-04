import { NextResponse } from "next/server";

import { cpFetchJsonSafe, withControlPlaneNetwork } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const { response, payload, network } = await cpFetchJsonSafe("/v1/strategies/drift-thresholds");
  return NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json();
  const { response, payload, network } = await cpFetchJsonSafe("/v1/strategies/drift-thresholds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
}
