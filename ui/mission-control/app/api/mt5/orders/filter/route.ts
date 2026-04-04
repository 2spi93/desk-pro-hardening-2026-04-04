import { NextResponse } from "next/server";

import {
  classifyControlPlaneNetworkRegime,
  computeControlPlaneInfraHealth,
  cpFetchJsonSafe,
  extractMcContextHeaders,
  getControlPlaneNetworkMetricsSnapshot,
} from "../../../../../lib/controlPlane";

type JsonMap = Record<string, unknown>;

type OrderIntentPayload = {
  source?: string;
  mode?: string;
  preset?: string;
  oco?: {
    enabled?: boolean;
    group_id?: string;
    cancel_policy?: string;
  };
  bracket?: {
    entry?: number;
    stop_loss?: number;
    take_profit?: number;
    rr_ratio?: number;
    risk_usd?: number;
    reward_usd?: number;
  };
  risk_preview?: {
    qty?: number;
    notional?: number;
    max_spread_bps?: number;
    max_loss_usd?: number;
    target_gain_usd?: number;
    target_rr?: number;
    guard_enabled?: boolean;
    confirm_ack?: boolean;
  };
};

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" ? (value as JsonMap) : {};
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function POST(request: Request): Promise<NextResponse> {
  const forwardedHeaders = extractMcContextHeaders(request);
  const raw = asObject(await request.json());
  const networkMetrics = getControlPlaneNetworkMetricsSnapshot();
  const infraHealth = computeControlPlaneInfraHealth(networkMetrics);
  const networkRegime = classifyControlPlaneNetworkRegime(networkMetrics, infraHealth);
  const side = asString(raw.side, "buy") === "sell" ? "sell" : "buy";
  const orderIntentRaw = asObject(raw.order_intent) as OrderIntentPayload;
  const bracket = asObject(orderIntentRaw.bracket);
  const oco = asObject(orderIntentRaw.oco);
  const riskPreview = asObject(orderIntentRaw.risk_preview);
  const predictorContext = asObject(raw.predictor_context);

  const normalizedOrderIntent: OrderIntentPayload | undefined = Object.keys(orderIntentRaw).length > 0
    ? {
      source: asString(orderIntentRaw.source, "terminal-chart"),
      mode: asString(orderIntentRaw.mode, "bracket"),
      preset: asString(orderIntentRaw.preset, "custom"),
      oco: {
        enabled: Boolean(oco.enabled),
        group_id: asString(oco.group_id) || (Boolean(oco.enabled) ? `oco-${Date.now()}-${Math.floor(Math.random() * 100000)}` : ""),
        cancel_policy: asString(oco.cancel_policy, "cancel-other-on-fill"),
      },
      bracket: {
        entry: asNumber(bracket.entry),
        stop_loss: asNumber(bracket.stop_loss),
        take_profit: asNumber(bracket.take_profit),
        rr_ratio: asNumber(bracket.rr_ratio),
        risk_usd: asNumber(bracket.risk_usd),
        reward_usd: asNumber(bracket.reward_usd),
      },
      risk_preview: {
        qty: asNumber(riskPreview.qty),
        notional: asNumber(riskPreview.notional),
        max_spread_bps: asNumber(riskPreview.max_spread_bps),
        max_loss_usd: asNumber(riskPreview.max_loss_usd),
        target_gain_usd: asNumber(riskPreview.target_gain_usd),
        target_rr: asNumber(riskPreview.target_rr),
        guard_enabled: Boolean(riskPreview.guard_enabled),
        confirm_ack: Boolean(riskPreview.confirm_ack),
      },
    }
    : undefined;

  const body = {
    account_id: asString(raw.account_id),
    symbol: asString(raw.symbol),
    side,
    preferred_venue: asString(raw.preferred_venue),
    lots: asNumber(raw.lots, 0.1),
    estimated_notional_usd: asNumber(raw.estimated_notional_usd),
    max_spread_bps: asNumber(raw.max_spread_bps),
    rationale: asString(raw.rationale),
    predictor_context: {
      ...predictorContext,
      infra_health: asNumber(predictorContext.infra_health, infraHealth),
      network_regime: asString(predictorContext.network_regime, networkRegime),
      network_metrics: Object.keys(asObject(predictorContext.network_metrics)).length > 0
        ? asObject(predictorContext.network_metrics)
        : networkMetrics,
    },
    order_intent: normalizedOrderIntent,
    // Compatibility fields for downstream services that consume top-level bracket/oco.
    bracket: normalizedOrderIntent?.bracket,
    oco: normalizedOrderIntent?.oco,
    metadata: {
      ...(asObject(raw.metadata)),
      ui: "mission-control-ui",
      schema_version: "mt5-order-filter-v2",
      submitted_at: new Date().toISOString(),
    },
  };

  const { response, payload } = await cpFetchJsonSafe("/v1/mt5/orders/filter", {
    method: "POST",
    headers: {
      ...Object.fromEntries(forwardedHeaders.entries()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const augmented = asObject(payload);
  if (normalizedOrderIntent) {
    augmented.order_intent = augmented.order_intent || normalizedOrderIntent;
    augmented.oco_group_id = asString(augmented.oco_group_id) || asString(normalizedOrderIntent.oco?.group_id);
  }
  return NextResponse.json(augmented, { status: response.status });
}
