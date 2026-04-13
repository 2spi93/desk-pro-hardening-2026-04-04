import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getControlPlaneUrl, readJsonFromResponseSafe } from "../../../../lib/controlPlane";
import { buildAppUrl, isHttpsRequest } from "../../../../lib/redirect";

function parseTokenRole(token: string): string {
  try {
    const parts = token.split(".");
    const payloadPart = parts.length === 2 ? parts[0] : parts[1];
    if (!payloadPart) {
      return "";
    }
    const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(decoded) as { role?: string };
    return String(payload.role || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function resolveSafeNextPath(value: string, fallback = "/terminal?v2=1"): string {
  const nextPath = String(value || "").trim();
  if (!nextPath.startsWith("/")) {
    return fallback;
  }
  if (nextPath.startsWith("//") || nextPath.startsWith("/api/") || nextPath.startsWith("/_next/")) {
    return fallback;
  }
  return nextPath;
}

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") || "";
  let username = "";
  let password = "";
  let nextPath = "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    username = String(body?.username || "");
    password = String(body?.password || "");
    nextPath = String(body?.next || "");
  } else {
    const form = await request.formData();
    username = String(form.get("username") || "");
    password = String(form.get("password") || "");
    nextPath = String(form.get("next") || "");
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
    const nextSuffix = nextPath ? `?next=${encodeURIComponent(resolveSafeNextPath(nextPath))}` : "";
    return NextResponse.redirect(buildAppUrl(request, `/change-password${nextSuffix}`));
  }

  const role = parseTokenRole(payload.access_token);
  const fallbackPath = role ? "/terminal?v2=1" : "/terminal?v2=1";
  return NextResponse.redirect(buildAppUrl(request, resolveSafeNextPath(nextPath, fallbackPath)));
}
