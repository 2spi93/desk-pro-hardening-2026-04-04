/**
 * OHLCV Data Engine V2 — Niveau Hedge Fund
 *
 * Pipeline canonique :
 *   RAW → alignToTimeSlot → normalizeBar → buildTimeSeries (gap fill) → sequencer
 *   + applyTickToLastBar : injection de tick live sans polling
 *
 * Objectif : timestamps alignés, séries continues, bougie live fluide.
 */

import type { NormalizedOhlcvBar } from "./ohlcvIntegrity";

// ── Timeframe → ms ────────────────────────────────────────────────────────────

const MONTH_TIMEFRAME = "month" as const;

const TF_MS: Record<string, number | typeof MONTH_TIMEFRAME> = {
  "1s": 1_000,
  "5s": 5_000,
  "10s": 10_000,
  "15s": 15_000,
  "30s": 30_000,
  "1m": 60_000,
  "2m": 120_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "45m": 2_700_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "3h": 10_800_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": MONTH_TIMEFRAME,
  // aliases fréquents
  "60m": 3_600_000,
  "90s": 90_000,
  "240m": 14_400_000,
  "d": 86_400_000,
  "w": 604_800_000,
};

export const SUPPORTED_TIMEFRAMES = [
  "1s",
  "5s",
  "10s",
  "15s",
  "30s",
  "1m",
  "2m",
  "3m",
  "5m",
  "15m",
  "30m",
  "45m",
  "1h",
  "2h",
  "3h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;

export type SupportedTimeframe = typeof SUPPORTED_TIMEFRAMES[number];

export function normalizeTimeframe(timeframe: string): string {
  const trimmed = String(timeframe || "").trim();
  if (!trimmed) {
    return "1m";
  }
  if (trimmed === "1M" || /^1mo(nth)?$/i.test(trimmed)) {
    return "1M";
  }
  const raw = trimmed.toLowerCase();
  if (raw === "d") return "1d";
  if (raw === "w") return "1w";
  if (raw === "60m") return "1h";
  if (raw === "240m") return "4h";
  if (/^(\d+)([smhdw])$/.test(raw)) {
    const match = raw.match(/^(\d+)([smhdw])$/);
    if (!match) {
      return "1m";
    }
    return `${Math.max(1, Number(match[1]))}${match[2]}`;
  }
  return TF_MS[trimmed] ? trimmed : TF_MS[raw] ? raw : "1m";
}

function timeframeUnitValue(timeframe: string): number | typeof MONTH_TIMEFRAME {
  const normalized = normalizeTimeframe(timeframe);
  const direct = TF_MS[normalized];
  if (direct) {
    return direct;
  }
  const match = normalized.match(/^(\d+)([smhdw])$/);
  if (!match) return 60_000;
  const amount = Math.max(1, Number(match[1]));
  const unit = match[2];
  const unitMs =
    unit === "s" ? 1_000 :
    unit === "m" ? 60_000 :
    unit === "h" ? 3_600_000 :
    unit === "d" ? 86_400_000 :
    604_800_000;
  return amount * unitMs;
}

export function isTimeframeSupported(timeframe: string): boolean {
  const normalized = normalizeTimeframe(timeframe);
  return normalized === "1M" || SUPPORTED_TIMEFRAMES.includes(normalized as SupportedTimeframe) || /^(\d+)([smhdw])$/.test(normalized);
}

export function timeframeToMs(timeframe: string): number {
  const value = timeframeUnitValue(timeframe);
  return value === MONTH_TIMEFRAME ? 31 * 86_400_000 : value;
}

export function canDeriveTimeframe(sourceTimeframe: string, targetTimeframe: string): boolean {
  return timeframeToMs(targetTimeframe) >= timeframeToMs(sourceTimeframe);
}

export function bucketStartForTimeframe(tsMs: number, timeframe: string): number {
  const value = timeframeUnitValue(timeframe);
  if (value === MONTH_TIMEFRAME) {
    const date = new Date(tsMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0);
  }
  return alignToTimeSlot(tsMs, value);
}

export function nextBucketStartForTimeframe(tsMs: number, timeframe: string): number {
  const value = timeframeUnitValue(timeframe);
  if (value === MONTH_TIMEFRAME) {
    const date = new Date(bucketStartForTimeframe(tsMs, timeframe));
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  }
  return bucketStartForTimeframe(tsMs, timeframe) + value;
}

// ── Slot alignment ────────────────────────────────────────────────────────────

/**
 * Aligne un timestamp (ms) sur la borne inférieure du slot TF.
 * Ex: t=14:03:37, tf=5m → 14:00:00
 */
export function alignToTimeSlot(tsMs: number, slotMs: number): number {
  return Math.floor(tsMs / slotMs) * slotMs;
}

/**
 * Aligne un timestamp ISO sur la borne inférieure du slot TF.
 */
export function alignIsoToSlot(iso: string, tf: string): string {
  const tsMs = Date.parse(iso);
  if (!Number.isFinite(tsMs)) return iso;
  return new Date(bucketStartForTimeframe(tsMs, tf)).toISOString();
}

// ── Time Series Engine ────────────────────────────────────────────────────────

const MAX_GAP_FILL = 200;

/**
 * Reconstruit une série temporelle continue :
 * - Aligne tous les timestamps sur les slots TF
 * - Trie par temps
 * - Déduplique (garde la dernière entrée par slot)
 * - Remplit les trous (gap fill)
 * - Ré-attribue les seq monotones
 */
export function buildTimeSeries(
  bars: NormalizedOhlcvBar[],
  tf: string,
): NormalizedOhlcvBar[] {
  if (bars.length === 0) return [];

  const slotMs = timeframeToMs(tf);

  // Étape 1 : aligner + dédupliquer par slot
  const slotMap = new Map<number, NormalizedOhlcvBar>();
  for (const bar of bars) {
    const tsMs = Date.parse(bar.t);
    if (!Number.isFinite(tsMs)) continue;
    const slot = bucketStartForTimeframe(tsMs, tf);
    const existing = slotMap.get(slot);
    // Si plusieurs barres tombent dans le même slot : garde la dernière reçue
    if (!existing || Date.parse(bar.t) >= Date.parse(existing.t)) {
      slotMap.set(slot, { ...bar, t: new Date(slot).toISOString() });
    }
  }

  // Étape 2 : trier par slot
  const sorted = [...slotMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, bar]) => bar);

  if (sorted.length === 0) return [];

  // Étape 3 : gap fill entre les slots existants
  const filled: NormalizedOhlcvBar[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = filled[filled.length - 1];
    const next = sorted[i];
    const prevSlot = Date.parse(prev.t);
    const nextSlot = Date.parse(next.t);
    const gapBars = Math.round((nextSlot - prevSlot) / slotMs) - 1;

    if (gapBars > 0 && gapBars <= MAX_GAP_FILL) {
      for (let gap = 1; gap <= gapBars; gap++) {
        const slot = prevSlot + gap * slotMs;
        const safeClose = prev.c > 0 ? prev.c : prev.o;
        filled.push({
          t: new Date(slot).toISOString(),
          o: safeClose,
          h: safeClose,
          l: safeClose,
          c: safeClose,
          v: 0,
          tf: tf || prev.tf,
          seq: 0,
          venue: prev.venue,
          instrument: prev.instrument,
          source: "data-engine-gap-fill",
        });
      }
    }
    filled.push(next);
  }

  // Étape 4 : séquence monotone
  return filled.map((bar, index) => ({ ...bar, seq: index + 1 }));
}

// ── Tick Live Injection ───────────────────────────────────────────────────────

/**
 * Applique un tick prix à la dernière bougie (ou crée une nouvelle bougie).
 *
 * RÈGLES :
 * - Si le tick appartient au slot de la dernière bougie → update c/h/l
 * - Si le tick est dans un slot plus récent → nouveau bar synthétique
 * - Si le prix est identique à c courant → retourne le même tableau (stable ref)
 */
export function applyTickToLastBar(
  bars: NormalizedOhlcvBar[],
  price: number,
  tsIso: string,
  tf: string,
): NormalizedOhlcvBar[] {
  if (bars.length === 0 || !Number.isFinite(price) || price <= 0) return bars;

  const slotMs = timeframeToMs(tf);
  const lastBar = bars[bars.length - 1];
  const lastSlotMs = Date.parse(lastBar.t);
  const tickMs = Date.parse(tsIso);

  if (!Number.isFinite(lastSlotMs)) return bars;

  // Tick dans un slot plus récent → nouvelle bougie synthétique
  if (Number.isFinite(tickMs) && tickMs >= nextBucketStartForTimeframe(lastSlotMs, tf)) {
    const newSlot = bucketStartForTimeframe(tickMs, tf);
    const safeClose = lastBar.c > 0 ? lastBar.c : price;
    const syntheticBar: NormalizedOhlcvBar = {
      t: new Date(newSlot).toISOString(),
      o: safeClose,
      h: Math.max(safeClose, price),
      l: Math.min(safeClose, price),
      c: price,
      v: 0,
      tf: tf || lastBar.tf,
      seq: lastBar.seq + 1,
      venue: lastBar.venue,
      instrument: lastBar.instrument,
      source: "tick-synthetic",
    };
    return [...bars, syntheticBar];
  }

  // Pas de changement de prix → retourne la même référence (stable pour useMemo)
  if (price === lastBar.c) return bars;

  // Mise à jour du close/high/low de la dernière bougie
  const updatedLast: NormalizedOhlcvBar = {
    ...lastBar,
    h: Math.max(lastBar.h, price),
    l: Math.min(lastBar.l, price),
    c: price,
    source: "tick-updated",
  };
  return [...bars.slice(0, -1), updatedLast];
}

// ── Normalizer bar seul ───────────────────────────────────────────────────────

/**
 * Normalise une barre brute : bounds OHLCV, timestamp aligné sur le slot TF.
 */
export function normalizeBarToSlot(
  bar: NormalizedOhlcvBar,
  tf: string,
): NormalizedOhlcvBar {
  const tsMs = Date.parse(bar.t);
  const alignedTs = Number.isFinite(tsMs)
    ? new Date(bucketStartForTimeframe(tsMs, tf)).toISOString()
    : bar.t;

  const o = bar.o > 0 ? bar.o : bar.c;
  const c = bar.c > 0 ? bar.c : o;
  const h = Math.max(o, c, bar.h > 0 ? bar.h : 0);
  const l = Math.min(o, c, bar.l > 0 ? bar.l : Infinity);
  const safeL = Number.isFinite(l) ? l : Math.min(o, c);

  return { ...bar, t: alignedTs, o, h, l: safeL, c, v: Math.max(0, bar.v) };
}

export function aggregateBarsToTimeframe(
  bars: NormalizedOhlcvBar[],
  tf: string,
): NormalizedOhlcvBar[] {
  if (bars.length === 0) {
    return [];
  }

  const targetTf = normalizeTimeframe(tf);
  const sorted = [...bars]
    .filter((bar) => Number.isFinite(Date.parse(bar.t)))
    .sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
  const bucketed = new Map<number, NormalizedOhlcvBar>();

  for (const bar of sorted) {
    const bucketStart = bucketStartForTimeframe(Date.parse(bar.t), targetTf);
    const bucketIso = new Date(bucketStart).toISOString();
    const existing = bucketed.get(bucketStart);
    if (!existing) {
      bucketed.set(bucketStart, {
        ...bar,
        t: bucketIso,
        tf: targetTf,
        seq: bucketStart,
      });
      continue;
    }
    bucketed.set(bucketStart, {
      ...existing,
      h: Math.max(existing.h, bar.h, bar.o, bar.c),
      l: Math.min(existing.l, bar.l, bar.o, bar.c),
      c: bar.c,
      v: Math.max(0, existing.v) + Math.max(0, bar.v),
      source: existing.source || bar.source,
    });
  }

  return [...bucketed.values()]
    .sort((left, right) => Date.parse(left.t) - Date.parse(right.t))
    .map((bar, index) => ({ ...bar, tf: targetTf, seq: index + 1 }));
}
