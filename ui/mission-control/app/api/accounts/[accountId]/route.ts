import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../../lib/controlPlane";

type RouteContext = {
  params: Promise<{ accountId: string }>;
};

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { accountId } = await context.params;
  const { response, payload } = await cpFetchJsonSafe(`/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
  return NextResponse.json(payload, { status: response.status });
}