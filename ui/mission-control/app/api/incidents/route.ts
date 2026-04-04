import { NextResponse } from "next/server";

import { cpFetchJsonSafe } from "../../../lib/controlPlane";
import { openIncidentTicket } from "../../../lib/incidentTickets";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const status = String(searchParams.get("status") || "").trim();
  const path = status ? `/v1/incidents?status=${encodeURIComponent(status)}` : "/v1/incidents";
  const { response, payload } = await cpFetchJsonSafe(path);
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ status: "error", detail: "title_required" }, { status: 400 });
  }
  const severity = body?.severity === "low" || body?.severity === "medium" || body?.severity === "high" || body?.severity === "critical"
    ? body.severity
    : "high";
  const payload = body?.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};
  const result = await openIncidentTicket({ title, severity, payload });
  return NextResponse.json({
    status: result.ok ? "ok" : "error",
    detail: result.detail,
    ticket_key: result.ticketKey,
  }, {
    status: result.ok ? 200 : Math.max(400, result.status),
  });
}
