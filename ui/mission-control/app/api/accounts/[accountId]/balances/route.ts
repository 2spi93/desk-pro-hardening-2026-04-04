import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function GET(
  _request: Request,
  context: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await context.params;
  const { response, payload } = await cpFetchJsonSafe(`/v1/accounts/${encodeURIComponent(accountId)}/balances`);
  return NextResponse.json(payload, { status: response.status });
}