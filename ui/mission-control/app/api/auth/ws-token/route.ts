import { NextResponse } from "next/server";

import { getControlPlaneToken, getControlPlaneUrl } from "../../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const token = await getControlPlaneToken();
  if (!token) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    token,
    controlPlaneUrl: getControlPlaneUrl(),
  });
}
