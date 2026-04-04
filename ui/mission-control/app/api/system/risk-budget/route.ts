import { NextResponse } from "next/server";

type JsonMap = Record<string, unknown>;

function getRiskGatewayBaseUrls(): string[] {
  const candidates = [
    String(process.env.RISK_GATEWAY_URL || "").trim(),
    String(process.env.RISK_GATEWAY_FALLBACK_URL || "").trim(),
    "http://risk-gateway:8001",
    "http://127.0.0.1:8001",
  ].filter(Boolean);

  return candidates.filter((value, index) => candidates.indexOf(value) === index);
}

async function fetchRiskGatewayJson(path: string): Promise<{ response: Response; payload: JsonMap | null; baseUrl: string | null }> {
  let lastResponse: Response | null = null;
  for (const baseUrl of getRiskGatewayBaseUrls()) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
      lastResponse = response;
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json().catch(() => null)) as JsonMap | null;
      return { response, payload, baseUrl };
    } catch {
      continue;
    }
  }

  return {
    response: lastResponse || new Response(null, { status: 503 }),
    payload: null,
    baseUrl: null,
  };
}

function toFiniteNumber(value: unknown): number | null {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export async function GET(): Promise<NextResponse> {
  const [policyResult, healthResult] = await Promise.all([
    fetchRiskGatewayJson("/v1/policies"),
    fetchRiskGatewayJson("/health"),
  ]);

  const limitUsd = toFiniteNumber(policyResult.payload?.daily_notional_limit_usd);
  const usedUsd = toFiniteNumber(healthResult.payload?.daily_notional_used_usd);
  const remainingUsd = limitUsd !== null && usedUsd !== null ? Math.max(0, limitUsd - usedUsd) : null;
  const status = limitUsd !== null && usedUsd !== null ? "ready" : "degraded";

  return NextResponse.json(
    {
      status,
      daily_notional_limit_usd: limitUsd,
      daily_notional_used_usd: usedUsd,
      daily_notional_remaining_usd: remainingUsd,
      policy_version: policyResult.payload?.policy_version ?? null,
      paper_only: policyResult.payload?.paper_only ?? null,
      source_base_url: healthResult.baseUrl || policyResult.baseUrl,
    },
    {
      status: status === "ready" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}