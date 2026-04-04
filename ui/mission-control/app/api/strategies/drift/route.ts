import { NextResponse } from "next/server";

import { cpFetchJsonSafe, withControlPlaneNetwork } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const { response, payload, network } = await cpFetchJsonSafe("/v1/strategies/drift");
  return NextResponse.json(withControlPlaneNetwork(payload, network), { status: response.status });
}
