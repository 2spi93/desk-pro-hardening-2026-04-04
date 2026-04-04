import { NextResponse } from "next/server";

import { cpFetch } from "../../../../../lib/controlPlane";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ strategyId: string }> }
): Promise<NextResponse> {
  const resolved = await params;
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await request.json().catch(() => ({}));
    const response = await cpFetch(`/v1/strategies/${resolved.strategyId}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({ detail: "strategy_promote_failed" }));
    return NextResponse.json(body, { status: response.status });
  }

  const form = await request.formData();
  const toLevel = Number(form.get("to_level") || 0);
  const rationale = String(form.get("rationale") || "");
  const sharpe = Number(form.get("sharpe") || 1.1);
  const maxDd = Number(form.get("max_dd") || 0);
  const sampleCount = Number(form.get("sample_count") || 250);
  const feeImpactBps = Number(form.get("fee_impact_bps") || 8);
  const slippageBps = Number(form.get("slippage_bps") || 6);
  const metrics = {
    sharpe,
    max_dd: maxDd,
    // Control-plane promotion gates rely on these fields.
    sample_count: Number.isFinite(sampleCount) ? sampleCount : 250,
    oos_sharpe: Number.isFinite(sharpe) ? sharpe : 1.1,
    fee_impact_bps: Number.isFinite(feeImpactBps) ? feeImpactBps : 8,
    slippage_bps: Number.isFinite(slippageBps) ? slippageBps : 6,
  };

  const response = await cpFetch(`/v1/strategies/${resolved.strategyId}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to_level: toLevel, rationale, metrics }),
  });

  if (!response.ok) {
    return NextResponse.redirect(new URL("/?promote_error=1", request.url));
  }
  return NextResponse.redirect(new URL("/", request.url));
}
