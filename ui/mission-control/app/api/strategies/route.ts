import { NextResponse } from "next/server";

import { cpFetch, cpFetchJsonSafe } from "../../../lib/controlPlane";

export async function GET(): Promise<NextResponse> {
  const { response, payload } = await cpFetchJsonSafe("/v1/strategies");
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await request.json().catch(() => ({}));
    const response = await cpFetch("/v1/strategies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({ detail: "strategy_create_failed" }));
    return NextResponse.json(body, { status: response.status });
  }

  const form = await request.formData();
  const payload = {
    strategy_id: String(form.get("strategy_id") || "").trim(),
    name: String(form.get("name") || "").trim(),
    market: String(form.get("market") || "").trim(),
    setup_type: String(form.get("setup_type") || "").trim(),
    notes: String(form.get("notes") || "").trim(),
  };

  const response = await cpFetch("/v1/strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return NextResponse.redirect(new URL("/?strategy_error=1", request.url));
  }
  return NextResponse.redirect(new URL("/", request.url));
}
