import { NextRequest, NextResponse } from "next/server";

import { fallbackMicrostructure, fallbackSessionState } from "../../../../../lib/binanceMarketFallback";
import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../../lib/controlPlane";

type JsonMap = Record<string, unknown>;

function toNumber(value: unknown, fallback = NaN): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function timeframeToMs(timeframe: string): number {
  const normalized = String(timeframe || "1m").trim().toLowerCase();
  const match = normalized.match(/^(\d+)([mhd])$/);
  if (!match) {
    return 60_000;
  }
  const value = Math.max(1, Number(match[1] || "1"));
  const unit = match[2];
  if (unit === "m") {
    return value * 60_000;
  }
  if (unit === "h") {
    return value * 3_600_000;
  }
  return value * 86_400_000;
}

function resolveBarTimeMs(row: unknown): number {
  const entry = (row && typeof row === "object") ? row as JsonMap : {};
  const numeric = toNumber(entry.time ?? entry.timestamp ?? entry.ts, NaN);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const text = String(entry.label || entry.timeLabel || "").trim();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function computeOhlcvSequencing(rows: unknown[], timeframeMs: number): { contiguous: boolean; latestSeq: number | null } {
  if (!Array.isArray(rows) || rows.length < 2) {
    const latestSeq = rows.length > 0 ? rows.length : null;
    return { contiguous: rows.length <= 1, latestSeq };
  }
  const times = rows
    .map((row) => resolveBarTimeMs(row))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (times.length < 2) {
    return { contiguous: false, latestSeq: rows.length };
  }
  const toleranceMs = Math.max(1_000, Math.round(timeframeMs * 0.25));
  let contiguous = true;
  for (let index = 1; index < times.length; index += 1) {
    const delta = times[index] - times[index - 1];
    if (Math.abs(delta - timeframeMs) > toleranceMs) {
      contiguous = false;
      break;
    }
  }
  return { contiguous, latestSeq: rows.length };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const instrument = request.nextUrl.searchParams.get("instrument") || "BTCUSDT";
  const venue = request.nextUrl.searchParams.get("venue") || "binance-public";
  const timeframe = request.nextUrl.searchParams.get("timeframe") || "1m";
  const lookbackMinutes = request.nextUrl.searchParams.get("lookback_minutes") || "60";
  const tradeLimit = request.nextUrl.searchParams.get("trade_limit") || "200";

  const { response, payload } = await cpFetchJsonSafe(
    `/v1/market/bus/snapshot?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&timeframe=${encodeURIComponent(timeframe)}&lookback_minutes=${encodeURIComponent(lookbackMinutes)}&trade_limit=${encodeURIComponent(tradeLimit)}`,
    { headers: extractMcContextHeaders(request) },
  );

  if (response.ok) {
    return NextResponse.json(payload, {
      status: response.status,
      headers: {
        "X-Data-Source": "market-bus-snapshot",
      },
    });
  }

  const headers = extractMcContextHeaders(request);
  const baseUrl = new URL(request.url).origin;
  const [ohlcvRows, depthSnapshot, microstructure, tradesPayload] = await Promise.all([
    fetch(`${baseUrl}/api/market/ohlcv?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&timeframe=${encodeURIComponent(timeframe)}&limit=500`, {
      cache: "no-store",
      headers,
    }).then((res) => (res.ok ? res.json() : [])).catch(() => []),
    fetch(`${baseUrl}/api/market/orderbook/depth?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}`, {
      cache: "no-store",
      headers,
    }).then((res) => (res.ok ? res.json() : null)).catch(() => null),
    fallbackMicrostructure(instrument),
    cpFetchJsonSafe(
      `/v1/market/trades?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&limit=${encodeURIComponent(tradeLimit)}`,
      { headers },
    ).then(({ response, payload }) => (response.ok ? payload : [])).catch(() => []),
  ]);

  const nowMs = Date.now();
  const timeframeMs = timeframeToMs(timeframe);
  const latestBarMs = Array.isArray(ohlcvRows)
    ? ohlcvRows.reduce((latest, row) => {
      const rowTime = resolveBarTimeMs(row);
      return Number.isFinite(rowTime) ? Math.max(latest, rowTime) : latest;
    }, Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  const ohlcvFreshnessMs = Number.isFinite(latestBarMs) ? Math.max(0, nowMs - latestBarMs) : -1;

  const depthMap = (depthSnapshot && typeof depthSnapshot === "object") ? depthSnapshot as JsonMap : {};
  const depthUpdateId = depthMap.last_update_id
    ?? depthMap.final_update_id
    ?? depthMap.update_id
    ?? null;
  const depthTimestampMsRaw = toNumber(depthMap.timestamp ?? depthMap.time ?? depthMap.ts, NaN);
  const depthTimestampMs = Number.isFinite(depthTimestampMsRaw)
    ? (depthTimestampMsRaw > 1e12 ? depthTimestampMsRaw : depthTimestampMsRaw * 1000)
    : NaN;
  const depthFreshnessMs = Number.isFinite(depthTimestampMs)
    ? Math.max(0, nowMs - depthTimestampMs)
    : (depthSnapshot ? 0 : -1);

  const sequencing = computeOhlcvSequencing(Array.isArray(ohlcvRows) ? ohlcvRows : [], timeframeMs);
  const hasAnyMarketPayload = (Array.isArray(ohlcvRows) && ohlcvRows.length > 0) || Boolean(depthSnapshot);
  const fallbackStatus = hasAnyMarketPayload ? "degraded" : "offline";

  const trades = Array.isArray(tradesPayload)
    ? tradesPayload
    : (tradesPayload && typeof tradesPayload === "object" && Array.isArray((tradesPayload as JsonMap).items))
      ? (tradesPayload as JsonMap).items as unknown[]
      : [];
  const latestTradeMs = trades.reduce((latest, trade) => {
    const entry = (trade && typeof trade === "object") ? trade as JsonMap : {};
    const raw = toNumber(entry.T ?? entry.ts ?? entry.timestamp ?? entry.time, NaN);
    if (!Number.isFinite(raw) || raw <= 0) {
      return latest;
    }
    const next = raw > 1e12 ? raw : raw * 1000;
    return Math.max(latest, next);
  }, Number.NEGATIVE_INFINITY);
  const tradesFreshnessMs = Number.isFinite(latestTradeMs) ? Math.max(0, nowMs - latestTradeMs) : -1;

  return NextResponse.json({
    instrument,
    venue,
    timeframe,
    trades,
    microstructure,
    session_state: fallbackSessionState(instrument),
    orderbook: depthSnapshot,
    routing_score: null,
    ohlcv_rows: Array.isArray(ohlcvRows) ? ohlcvRows : [],
    depth_snapshot: depthSnapshot,
    meta: {
      health: {
        status: fallbackStatus,
        reason: response.status === 404 ? "control_plane_snapshot_missing" : "control_plane_snapshot_unavailable",
        components: {
          ohlcv: {
            freshness_ms: ohlcvFreshnessMs,
          },
          depth: {
            freshness_ms: depthFreshnessMs,
          },
          trades: {
            freshness_ms: tradesFreshnessMs,
          },
        },
      },
      sequencing: {
        ohlcv: {
          latest_seq: sequencing.latestSeq,
          contiguous: sequencing.contiguous,
        },
        depth: {
          last_update_id: depthUpdateId,
        },
      },
    },
    as_of: new Date().toISOString(),
  }, {
    status: 200,
    headers: {
      "X-Data-Source": "market-bus-snapshot-fallback",
    },
  });
}