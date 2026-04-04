import { NextResponse } from "next/server";

import { cpFetch } from "../../../../lib/controlPlane";
import { buildAppUrl } from "../../../../lib/redirect";

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const oldPassword = String(form.get("old_password") || "");
  const newPassword = String(form.get("new_password") || "");
  const confirmPassword = String(form.get("confirm_password") || "");

  if (newPassword.length < 12 || newPassword !== confirmPassword) {
    return NextResponse.redirect(buildAppUrl(request, "/change-password?error=1"));
  }

  const response = await cpFetch("/v1/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });

  if (!response.ok) {
    return NextResponse.redirect(buildAppUrl(request, "/change-password?error=1"));
  }

  return NextResponse.redirect(buildAppUrl(request, "/?password_changed=1"));
}
