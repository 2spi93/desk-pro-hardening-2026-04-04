import { alignIsoToSlot, buildTimeSeries, timeframeToMs } from "./ohlcvDataEngine";

export type NormalizedOhlcvBar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tf: string;
  seq: number;
  venue?: string;
  instrument?: string;
  source?: string;
};

export type OhlcvRenderabilityAnalysis = {
  signal: "OHLCV_RENDERABLE" | "OHLCV_PARTIAL" | "OHLCV_UNUSABLE";
  renderable: boolean;
  fetchedRows: number;
  renderableRows: number;
  droppedRows: number;
  duplicateTimestamps: number;
  minimumRenderableBars: number;
  reasons: string[];
  droppedReasonKinds: string[];
  firstTimestamp: string | null;
  lastTimestamp: string | null;
};

type NormalizeOhlcvOptions = {
  instrument?: string;
  venue?: string;
  timeframe?: string;
};

export const DEFAULT_MIN_RENDERABLE_BARS = 20;

const MAX_GAP_FILL_BARS = 120;

function toFiniteNumber(value: unknown, fallback = Number.NaN): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toIsoTime(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const millis = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
      const timestamp = new Date(millis);
      return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    const timestamp = new Date(millis);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  return null;
}

function normalizeSingleOhlcvRow(
  entry: unknown,
  index: number,
  options: NormalizeOhlcvOptions,
): NormalizedOhlcvBar | null {
  return analyzeSingleOhlcvRow(entry, index, options).row;
}

function analyzeSingleOhlcvRow(
  entry: unknown,
  index: number,
  options: NormalizeOhlcvOptions,
): { row: NormalizedOhlcvBar | null; reason: string | null } {
  const row = entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : null;
  if (!row) {
    return { row: null, reason: "non_object_row" };
  }

  const timestamp = toIsoTime(row.t ?? row.bucket_start ?? row.time ?? row.ts);
  if (!timestamp) {
    return { row: null, reason: "invalid_timestamp" };
  }

  const rawOpen = toFiniteNumber(row.o ?? row.open);
  const rawClose = toFiniteNumber(row.c ?? row.close, rawOpen);
  const open = rawOpen > 0 ? rawOpen : rawClose;
  const close = rawClose > 0 ? rawClose : open;

  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) {
    return { row: null, reason: "invalid_open_close" };
  }

  const rawHigh = toFiniteNumber(row.h ?? row.high);
  const rawLow = toFiniteNumber(row.l ?? row.low);
  const high = Math.max(open, close, rawHigh > 0 ? rawHigh : Number.NEGATIVE_INFINITY);
  const low = Math.min(open, close, rawLow > 0 ? rawLow : Number.POSITIVE_INFINITY);
  if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) {
    return { row: null, reason: "invalid_ohlc_bounds" };
  }

  const volume = Math.max(0, toFiniteNumber(row.v ?? row.volume, 0));

  return {
    row: {
      t: timestamp,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
      tf: String((row.tf ?? row.timeframe ?? options.timeframe ?? "1m") || "1m"),
      seq: Math.max(1, Math.trunc(toFiniteNumber(row.seq, index + 1))),
      venue: typeof row.venue === "string" ? row.venue : options.venue,
      instrument: typeof row.instrument === "string" ? row.instrument : options.instrument,
      source: typeof row.source === "string" ? row.source : "normalized-ohlcv",
    },
    reason: null,
  };
}

export function normalizeOhlcvRows(
  payload: unknown,
  options: NormalizeOhlcvOptions = {},
): NormalizedOhlcvBar[] {
  const rows = Array.isArray(payload) ? payload : [];
  const tf = options.timeframe || "1m";

  // Étape 1 : normalisation individuelle des lignes brutes
  const normalized = rows
    .map((entry, index) => normalizeSingleOhlcvRow(entry, index, options))
    .filter((row): row is NormalizedOhlcvBar => Boolean(row));

  // Étape 2 : aligner tous les timestamps sur les bornes de slot TF
  //           AVANT dédupplication — évite les décalages résidus d'API
  const aligned = normalized.map((row) => ({
    ...row,
    t: alignIsoToSlot(row.t, tf),
  }));

  // Étape 3 : passer par le Time Series Engine V2 (slot map + gap fill + séquence)
  return buildTimeSeries(aligned, tf);
}

function fillMissingTimeSlots(rows: NormalizedOhlcvBar[], timeframe: string): NormalizedOhlcvBar[] {
  if (rows.length <= 1) {
    return rows;
  }

  const slotMs = timeframeToMs(timeframe);
  if (!Number.isFinite(slotMs) || slotMs <= 0) {
    return rows;
  }

  const filled: NormalizedOhlcvBar[] = [rows[0]];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = filled[filled.length - 1];
    const next = rows[index];
    const prevTs = Date.parse(prev.t);
    const nextTs = Date.parse(next.t);
    if (!Number.isFinite(prevTs) || !Number.isFinite(nextTs) || nextTs <= prevTs) {
      filled.push(next);
      continue;
    }

    const gapBars = Math.round((nextTs - prevTs) / slotMs) - 1;
    if (gapBars > 0 && gapBars <= MAX_GAP_FILL_BARS) {
      for (let gap = 1; gap <= gapBars; gap += 1) {
        const ts = prevTs + gap * slotMs;
        const close = Number(prev.c);
        const safeClose = Number.isFinite(close) && close > 0 ? close : Number(next.o) || 0;
        filled.push({
          t: new Date(ts).toISOString(),
          o: safeClose,
          h: safeClose,
          l: safeClose,
          c: safeClose,
          v: 0,
          tf: next.tf || prev.tf || timeframe,
          seq: 0,
          venue: next.venue || prev.venue,
          instrument: next.instrument || prev.instrument,
          source: "normalized-ohlcv-gap-fill",
        });
      }
    }

    filled.push(next);
  }

  return filled;
}

export function analyzeOhlcvRows(
  payload: unknown,
  options: NormalizeOhlcvOptions = {},
  minimumRenderableBars = DEFAULT_MIN_RENDERABLE_BARS,
): OhlcvRenderabilityAnalysis {
  const rows = Array.isArray(payload) ? payload : [];
  const droppedReasonKinds = new Set<string>();
  const normalized: NormalizedOhlcvBar[] = [];

  for (const [index, entry] of rows.entries()) {
    const analyzed = analyzeSingleOhlcvRow(entry, index, options);
    if (analyzed.row) {
      normalized.push(analyzed.row);
      continue;
    }
    if (analyzed.reason) {
      droppedReasonKinds.add(analyzed.reason);
    }
  }

  normalized.sort((left, right) => {
    const leftTs = Date.parse(left.t);
    const rightTs = Date.parse(right.t);
    if (leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    return left.seq - right.seq;
  });

  const deduped: NormalizedOhlcvBar[] = [];
  const seen = new Set<string>();
  let duplicateTimestamps = 0;
  for (const row of normalized) {
    if (seen.has(row.t)) {
      duplicateTimestamps += 1;
      continue;
    }
    seen.add(row.t);
    deduped.push(row);
  }

  const reasons: string[] = [];
  if (rows.length === 0) {
    reasons.push("no_rows_received");
  }
  if (deduped.length === 0) {
    reasons.push("no_renderable_rows");
  } else if (deduped.length < minimumRenderableBars) {
    reasons.push("insufficient_renderable_bars");
  }
  if (rows.length - deduped.length > 0) {
    reasons.push("rows_dropped_during_normalization");
  }
  if (duplicateTimestamps > 0) {
    reasons.push("duplicate_timestamps_deduped");
  }

  let signal: OhlcvRenderabilityAnalysis["signal"] = "OHLCV_RENDERABLE";
  if (deduped.length === 0) {
    signal = "OHLCV_UNUSABLE";
  } else if (deduped.length < minimumRenderableBars) {
    signal = "OHLCV_PARTIAL";
  }

  return {
    signal,
    renderable: signal === "OHLCV_RENDERABLE",
    fetchedRows: rows.length,
    renderableRows: deduped.length,
    droppedRows: rows.length - deduped.length,
    duplicateTimestamps,
    minimumRenderableBars,
    reasons,
    droppedReasonKinds: [...droppedReasonKinds],
    firstTimestamp: deduped[0]?.t || null,
    lastTimestamp: deduped[deduped.length - 1]?.t || null,
  };
}