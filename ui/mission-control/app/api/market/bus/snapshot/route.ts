import { NextRequest, NextResponse } from "next/server";

import { fallbackMicrostructure, fallbackSessionState } from "../../../../../lib/binanceMarketFallback";
import { cpFetchJsonSafe, extractMcContextHeaders } from "../../../../../lib/controlPlane";
import { assessMarketSnapshot, attachMarketSnapshotAssessment, shouldUseCanonicalSnapshot } from "../../../../../lib/marketSnapshotContract";

type JsonMap = Record<string, unknown>;

function safeRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : {};
}

function toNumber(value: unknown, fallback = NaN): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function timeframeToMs(timeframe: string): number {
  const normalized = String(timeframe || "1m").trim().toLowerCase();
  const match = normalized.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 60_000;
  }
  const value = Math.max(1, Number(match[1] || "1"));
  const unit = match[2];
  if (unit === "s") {
    return value * 1_000;
  }
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
  const numeric = toNumber(entry.t ?? entry.bucket_start ?? entry.time ?? entry.timestamp ?? entry.ts, NaN);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const text = String(entry.t ?? entry.bucket_start ?? entry.label ?? entry.timeLabel ?? "").trim();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function resolveBarSeq(row: unknown): number | null {
  const entry = (row && typeof row === "object") ? row as JsonMap : {};
  const seq = toNumber(entry.seq, NaN);
  if (!Number.isFinite(seq)) {
    return null;
  }
  return Math.max(1, Math.trunc(seq));
}

function computeOhlcvSequencing(rows: unknown[], timeframeMs: number): { contiguous: boolean; latestSeq: number | null } {
  const latestSeq = Array.isArray(rows)
    ? rows.reduce<number | null>((latest, row, index) => {
      const candidate = resolveBarSeq(row) ?? (index + 1);
      return latest === null ? candidate : Math.max(latest, candidate);
    }, null)
    : null;
  if (!Array.isArray(rows) || rows.length < 2) {
    return { contiguous: rows.length <= 1, latestSeq };
  }
  const times = rows
    .map((row) => resolveBarTimeMs(row))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (times.length < 2) {
    return { contiguous: false, latestSeq };
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
  return { contiguous, latestSeq };
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

  const controlPlaneAssessment = assessMarketSnapshot(payload);
  if (shouldUseCanonicalSnapshot(response.ok, controlPlaneAssessment)) {
    return NextResponse.json(attachMarketSnapshotAssessment(payload, controlPlaneAssessment), {
      status: response.status,
      headers: {
        "X-Data-Source": "market-bus-snapshot",
        "X-Market-Snapshot-Availability": controlPlaneAssessment.state,
      },
    });
  }

  const headers = extractMcContextHeaders(request);
  const baseUrl = new URL(request.url).origin;
  const [ohlcvRows, depthSnapshot, microstructure, tradesPayload, tradePreprocessorJournalPayload, tradePreprocessorAnalyticsPayload] = await Promise.all([
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
      `/v1/market/trades/preprocessed?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&limit=${encodeURIComponent(tradeLimit)}`,
      { headers },
    ).then(({ response, payload }) => (response.ok ? payload : { items: [] })).catch(() => ({ items: [] })),
    cpFetchJsonSafe(
      `/v1/market/trades/preprocessor/journal?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&hours=12&limit=24`,
      { headers },
    ).then(({ response, payload }) => (response.ok ? payload : { items: [], summary: {} })).catch(() => ({ items: [], summary: {} })),
    cpFetchJsonSafe(
      `/v1/market/trades/preprocessor/analytics?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&limit=12`,
      { headers },
    ).then(({ response, payload }) => (response.ok ? payload : { windows: {}, thresholds: {} })).catch(() => ({ windows: {}, thresholds: {} })),
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
  const tradePreprocessor = (tradesPayload && typeof tradesPayload === "object" && !Array.isArray(tradesPayload))
    ? (((tradesPayload as JsonMap).preprocessor && typeof (tradesPayload as JsonMap).preprocessor === "object")
      ? (tradesPayload as JsonMap).preprocessor as JsonMap
      : null)
    : null;
  const tradePreprocessorJournal = (tradePreprocessorJournalPayload && typeof tradePreprocessorJournalPayload === "object" && !Array.isArray(tradePreprocessorJournalPayload))
    ? (Array.isArray((tradePreprocessorJournalPayload as JsonMap).items)
      ? (tradePreprocessorJournalPayload as JsonMap).items as JsonMap[]
      : [])
    : [];
  const tradePreprocessorJournalSummary = (tradePreprocessorJournalPayload && typeof tradePreprocessorJournalPayload === "object" && !Array.isArray(tradePreprocessorJournalPayload))
    ? ((((tradePreprocessorJournalPayload as JsonMap).summary) && typeof (tradePreprocessorJournalPayload as JsonMap).summary === "object")
      ? (tradePreprocessorJournalPayload as JsonMap).summary as JsonMap
      : null)
    : null;
  const tradePreprocessorAnalytics = (tradePreprocessorAnalyticsPayload && typeof tradePreprocessorAnalyticsPayload === "object" && !Array.isArray(tradePreprocessorAnalyticsPayload))
    ? tradePreprocessorAnalyticsPayload as JsonMap
    : null;
  const tradePreprocessorThresholds = safeRecord(tradePreprocessorAnalytics?.thresholds);
  const analytics24h = Array.isArray(safeRecord(tradePreprocessorAnalytics?.windows).last_24h)
    ? safeRecord(tradePreprocessorAnalytics?.windows).last_24h as JsonMap[]
    : [];
  const priceDiscovery24h = analytics24h.find((row) => String(row.market_regime || "") === "price_discovery") || null;
  const thresholdSavedPct = toNumber(tradePreprocessorThresholds.price_discovery_saved_pct, 30);
  const thresholdRawCount = Math.max(1, Math.trunc(toNumber(tradePreprocessorThresholds.price_discovery_min_raw_count, 40)));
  const currentSavedPct = toNumber(tradePreprocessor?.compression_saved_pct, 0);
  const currentRawCount = Math.max(0, Math.trunc(toNumber(tradePreprocessor?.raw_count, 0)));
  const currentRegime = String(tradePreprocessor?.market_regime || "unknown");
  const aggressiveBuckets24h = priceDiscovery24h ? Math.max(0, Math.trunc(toNumber(priceDiscovery24h.aggressive_bucket_count, 0))) : 0;
  const tradePreprocessorAlert = currentRegime === "price_discovery" && currentRawCount >= thresholdRawCount && currentSavedPct >= thresholdSavedPct
    ? {
      state: "warn",
      triggered: true,
      reason_code: "price-discovery-compression-too-high",
      threshold_saved_pct: thresholdSavedPct,
      threshold_raw_count: thresholdRawCount,
      summary: `Price discovery compression too aggressive: ${currentSavedPct.toFixed(1)}% saved on raw ${currentRawCount}.`,
      current_saved_pct: currentSavedPct,
      current_raw_count: currentRawCount,
      aggressive_buckets_24h: aggressiveBuckets24h,
    }
    : aggressiveBuckets24h > 0
      ? {
        state: "watch",
        triggered: true,
        reason_code: "price-discovery-buckets-over-threshold-24h",
        threshold_saved_pct: thresholdSavedPct,
        threshold_raw_count: thresholdRawCount,
        summary: `24h price discovery alert buckets: ${aggressiveBuckets24h} (max saved ${toNumber(priceDiscovery24h?.max_saved_pct, 0).toFixed(1)}%).`,
        current_saved_pct: currentSavedPct,
        current_raw_count: currentRawCount,
        aggressive_buckets_24h: aggressiveBuckets24h,
      }
      : {
        state: "ok",
        triggered: false,
        reason_code: "within-threshold",
        threshold_saved_pct: thresholdSavedPct,
        threshold_raw_count: thresholdRawCount,
        summary: `Compression within price discovery threshold (${currentSavedPct.toFixed(1)}% / raw ${currentRawCount}).`,
        current_saved_pct: currentSavedPct,
        current_raw_count: currentRawCount,
        aggressive_buckets_24h: aggressiveBuckets24h,
      };
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

  const fallbackPayload = {
    contract_version: "txt.market-bus-snapshot.v1",
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
        reason: controlPlaneAssessment.reasons[0]
          || (response.status === 404 ? "control_plane_snapshot_missing" : "control_plane_snapshot_unavailable"),
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
      preprocessor: {
        trades: {
          ...(tradePreprocessor || {}),
          journal: tradePreprocessorJournal,
          journal_summary: tradePreprocessorJournalSummary,
          analytics: tradePreprocessorAnalytics,
          alert: tradePreprocessorAlert,
        },
      },
    },
    observation: {
      observed_at: new Date().toISOString(),
      source: "mission-control-market-bus-fallback",
    },
    as_of: new Date().toISOString(),
  };
  const fallbackAssessment = assessMarketSnapshot(fallbackPayload);
  return NextResponse.json(attachMarketSnapshotAssessment(fallbackPayload, fallbackAssessment), {
    status: 200,
    headers: {
      "X-Data-Source": "market-bus-snapshot-fallback",
      "X-Market-Snapshot-Availability": fallbackAssessment.state,
      "X-Control-Plane-Contract-Error": controlPlaneAssessment.reasons.join(",").slice(0, 512),
    },
  });
}
