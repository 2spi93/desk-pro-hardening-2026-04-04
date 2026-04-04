import { NextResponse } from "next/server";

import { getControlPlaneToken, getControlPlaneUrl } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const token = await getControlPlaneToken();
  return NextResponse.json({
    authenticated: Boolean(token),
    controlPlaneUrl: getControlPlaneUrl(),
  });
}