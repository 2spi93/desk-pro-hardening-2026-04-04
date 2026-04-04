import { NextRequest, NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await context.params;
  const query = request.nextUrl.searchParams.toString();
  const path = `/v1/accounts/${encodeURIComponent(accountId)}/capital-flows${query ? `?${query}` : ""}`;
  const { response, payload } = await cpFetchJsonSafe(path);
  return NextResponse.json(payload, { status: response.status });
}