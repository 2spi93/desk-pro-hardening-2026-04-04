import { NextResponse } from "next/server";

import { cpFetch } from "../../../../lib/controlPlane";
import { buildAppUrl } from "../../../../lib/redirect";

function resolveSafeNextPath(value: string, fallback = "/terminal?v2=1&password_changed=1"): string {
  const nextPath = String(value || "").trim();
  if (!nextPath.startsWith("/")) {
    return fallback;
  }
  if (nextPath.startsWith("//") || nextPath.startsWith("/api/") || nextPath.startsWith("/_next/")) {
    return fallback;
  }
  return nextPath.includes("?") ? `${nextPath}&password_changed=1` : `${nextPath}?password_changed=1`;
}

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const oldPassword = String(form.get("old_password") || "");
  const newPassword = String(form.get("new_password") || "");
  const confirmPassword = String(form.get("confirm_password") || "");
  const nextPath = String(form.get("next") || "");

  if (newPassword.length < 12 || newPassword !== confirmPassword) {
    const suffix = nextPath ? `&next=${encodeURIComponent(nextPath)}` : "";
    return NextResponse.redirect(buildAppUrl(request, `/change-password?error=1${suffix}`));
  }

  const response = await cpFetch("/v1/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });

  if (!response.ok) {
    const suffix = nextPath ? `&next=${encodeURIComponent(nextPath)}` : "";
    return NextResponse.redirect(buildAppUrl(request, `/change-password?error=1${suffix}`));
  }

  return NextResponse.redirect(buildAppUrl(request, resolveSafeNextPath(nextPath)));
}
