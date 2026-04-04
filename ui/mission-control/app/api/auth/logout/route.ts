import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { buildAppUrl } from "../../../../lib/redirect";

export async function POST(request: Request): Promise<NextResponse> {
  const cookieStore = await cookies();
  cookieStore.delete("mc_token");
  cookieStore.delete("mc_token_compat");
  return NextResponse.redirect(buildAppUrl(request, "/login"));
}
