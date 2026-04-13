import { NextResponse } from "next/server";

import { getControlPlaneToken } from "./controlPlane";

export function unauthorizedJson(message = "Authentication required"): NextResponse {
  return NextResponse.json(
    { message },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    },
  );
}

export async function requireControlPlaneSession(): Promise<NextResponse | null> {
  const token = await getControlPlaneToken();
  return token ? null : unauthorizedJson();
}