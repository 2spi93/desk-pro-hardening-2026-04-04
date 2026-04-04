import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getControlPlaneUrl, readJsonFromResponseSafe } from "../../../../lib/controlPlane";
import { buildAppUrl, isHttpsRequest } from "../../../../lib/redirect";

function getClientLoginUsernames(): string[] {
  const fromEnv = String(process.env.CLIENT_LOGIN_USERNAMES || "").trim();
  // Default to "client" ONLY — never fall back to internal accounts.
  // Configure CLIENT_LOGIN_USERNAMES to add more client-role usernames if needed.
  const ordered = (fromEnv || "client")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ordered.length > 0 ? ordered : ["client"];
}

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const clientCode = String(form.get("client_code") || "").trim();

  if (!clientCode) {
    return NextResponse.redirect(buildAppUrl(request, "/login?client_error=1"));
  }

  let response: Response | null = null;
  for (const username of getClientLoginUsernames()) {
    const attempt = await fetch(`${getControlPlaneUrl()}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password: clientCode,
      }),
      cache: "no-store",
    });
    if (attempt.ok) {
      response = attempt;
      break;
    }
  }

  if (!response) {
    return NextResponse.redirect(buildAppUrl(request, "/login?client_error=1"));
  }

  const payload = await readJsonFromResponseSafe(response) as {
    access_token?: string;
    password_must_change?: boolean;
  };

  if (!payload.access_token) {
    return NextResponse.redirect(buildAppUrl(request, "/login?client_error=1"));
  }

  const cookieStore = await cookies();
  const secureCookie = isHttpsRequest(request);
  cookieStore.set("mc_token", payload.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    path: "/",
    maxAge: 12 * 3600,
  });
  cookieStore.set("mc_token_compat", payload.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    path: "/",
    maxAge: 2 * 3600,
  });

  if (payload.password_must_change) {
    return NextResponse.redirect(buildAppUrl(request, "/change-password"));
  }

  return NextResponse.redirect(buildAppUrl(request, "/"));
}
