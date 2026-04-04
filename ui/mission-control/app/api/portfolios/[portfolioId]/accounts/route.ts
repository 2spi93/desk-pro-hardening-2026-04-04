import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";

export async function POST(
  request: Request,
  context: { params: Promise<{ portfolioId: string }> },
): Promise<NextResponse> {
  const { portfolioId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { response, payload } = await cpFetchJsonSafe(`/v1/portfolios/${encodeURIComponent(portfolioId)}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return NextResponse.json(payload, { status: response.status });
}