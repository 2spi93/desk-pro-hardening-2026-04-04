import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getControlPlaneUrl, readJsonFromResponseSafe } from "../../../../lib/controlPlane";
import { buildAppUrl, isHttpsRequest } from "../../../../lib/redirect";

function getAllowedUsernames(): string[] {
  const fromEnv = String(process.env.CLIENT_LOGIN_USERNAMES || "").trim();
  // Default to "client" ONLY — never allow selecting internal accounts.
  const ordered = (fromEnv || "client")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ordered.length > 0 ? ordered : ["client"];
}

function isAllowedUsername(username: string): boolean {
  return getAllowedUsernames().includes(username);
}

async function loginWithCredentials(username: string, password: string): Promise<Response> {
  return fetch(`${getControlPlaneUrl()}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });
}

async function rotatePasswordWithToken(token: string, oldPassword: string, newPassword: string): Promise<Response> {
  return fetch(`${getControlPlaneUrl()}/v1/auth/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    cache: "no-store",
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const username = String(form.get("client_username") || "").trim();
  const accessCode = String(form.get("client_code") || "").trim();
  const newPassword = String(form.get("new_password") || "");
  const confirmPassword = String(form.get("confirm_password") || "");

  if (!username || !accessCode || !newPassword || !confirmPassword) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=missing"));
  }

  if (!isAllowedUsername(username)) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=username"));
  }

  if (newPassword.length < 12 || newPassword !== confirmPassword) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=password"));
  }

  const initialLogin = await loginWithCredentials(username, accessCode);
  if (!initialLogin.ok) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=code"));
  }

  const initialPayload = await readJsonFromResponseSafe(initialLogin) as {
    access_token?: string;
  };

  if (!initialPayload.access_token) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=code"));
  }

  const changeResponse = await rotatePasswordWithToken(initialPayload.access_token, accessCode, newPassword);
  if (!changeResponse.ok) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=change"));
  }

  const finalLogin = await loginWithCredentials(username, newPassword);
  if (!finalLogin.ok) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=final"));
  }

  const finalPayload = await readJsonFromResponseSafe(finalLogin) as {
    access_token?: string;
    password_must_change?: boolean;
  };

  if (!finalPayload.access_token) {
    return NextResponse.redirect(buildAppUrl(request, "/login?onboard_error=final"));
  }

  const cookieStore = await cookies();
  const secureCookie = isHttpsRequest(request);
  cookieStore.set("mc_token", finalPayload.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    path: "/",
    maxAge: 12 * 3600,
  });
  cookieStore.set("mc_token_compat", finalPayload.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    path: "/",
    maxAge: 2 * 3600,
  });

  if (finalPayload.password_must_change) {
    return NextResponse.redirect(buildAppUrl(request, "/change-password"));
  }

  return NextResponse.redirect(buildAppUrl(request, "/?onboard=1"));
}