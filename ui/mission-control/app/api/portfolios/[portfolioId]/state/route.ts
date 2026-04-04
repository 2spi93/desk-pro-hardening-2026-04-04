import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function GET(
  _request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<NextResponse> {
  const { portfolioId } = await context.params;
  const { response, payload } = await cpFetchJsonSafe(`/v1/portfolios/${encodeURIComponent(portfolioId)}/state`);
  return NextResponse.json(payload, { status: response.status });
}