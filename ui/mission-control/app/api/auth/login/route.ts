import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getControlPlaneUrl, readJsonFromResponseSafe } from "../../../../lib/controlPlane";
import { buildAppUrl, isHttpsRequest } from "../../../../lib/redirect";

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") || "";
  let username = "";
  let password = "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    username = String(body?.username || "");
    password = String(body?.password || "");
  } else {
    const form = await request.formData();
    username = String(form.get("username") || "");
    password = String(form.get("password") || "");
  }

  const response = await fetch(`${getControlPlaneUrl()}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.redirect(buildAppUrl(request, "/login?error=1"));
  }

  const payload = await readJsonFromResponseSafe(response) as {
    access_token?: string;
    password_must_change?: boolean;
  };
  if (!payload.access_token) {
    return NextResponse.redirect(buildAppUrl(request, "/login?error=1"));
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
  // Chrome on some managed clients can reject secure cookies under proxied
  // mixed scheme paths; keep a short-lived compatibility cookie to avoid lockout.
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
