import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function POST(
  _request: Request,
  context: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await context.params;
  const { response, payload } = await cpFetchJsonSafe(`/v1/accounts/${encodeURIComponent(accountId)}/sync`, {
    method: "POST",
  });
  return NextResponse.json(payload, { status: response.status });
}