import { normalizeOhlcvRows, type NormalizedOhlcvBar } from "../../lib/ohlcvIntegrity";

export type TerminalDatasetMode = "live" | "locked" | "replay";

export type LockedDataset = {
  key: string;
  symbol: string;
  timeframe: string;
  candles: NormalizedOhlcvBar[];
  checksum: string;
  venue: string | null;
  source: string | null;
  profile: string;
  capturedAt: string | null;
  resolvedUrl: string;
};

type LockedDatasetPayload = {
  key?: unknown;
  symbol?: unknown;
  timeframe?: unknown;
  checksum?: unknown;
  venue?: unknown;
  source?: unknown;
  profile?: unknown;
  capturedAt?: unknown;
  candles?: unknown;
};

type LoadLockedDatasetInput = {
  symbol: string;
  timeframe: string;
  profile?: string;
  venue?: string | null;
  signal?: AbortSignal;
};

export const TERMINAL_DATA_MODE_STORAGE_KEY = "txt.terminal.data-mode";
export const TERMINAL_DATASET_PROFILE_STORAGE_KEY = "txt.terminal.dataset-profile";

const LOCKED_DATASET_PUBLIC_ROOT = "/locked-datasets";

function normalizeInstrument(symbol: string): string {
  return String(symbol || "").replace("-PERP", "").replace("/", "").replace(/-/g, "").toUpperCase();
}

function buildChartSymbolCandidates(symbol: string): string[] {
  const normalized = normalizeInstrument(symbol);
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  if (normalized.endsWith("USD") && !normalized.endsWith("USDT")) {
    candidates.add(`${normalized}T`);
  }
  if (normalized.endsWith("USDT")) {
    candidates.add(normalized.slice(0, -1));
  }
  return [...candidates];
}

function slugifyDatasetToken(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function computeLockedDatasetChecksum(candles: NormalizedOhlcvBar[]): string {
  let hash = 0x811c9dc5;
  for (const candle of candles) {
    const row = [
      candle.t,
      candle.o.toFixed(8),
      candle.h.toFixed(8),
      candle.l.toFixed(8),
      candle.c.toFixed(8),
      candle.v.toFixed(8),
      candle.tf,
      candle.instrument || "",
      candle.venue || "",
      candle.source || "",
    ].join("|");
    for (let index = 0; index < row.length; index += 1) {
      hash ^= row.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildLockedDatasetCandidateUrls(symbol: string, timeframe: string, profile = "reference"): string[] {
  const timeframeSlug = slugifyDatasetToken(timeframe);
  const profileSlug = slugifyDatasetToken(profile || "reference") || "reference";
  const candidates = new Set<string>();

  for (const candidateSymbol of buildChartSymbolCandidates(symbol)) {
    const symbolSlug = slugifyDatasetToken(candidateSymbol);
    if (!symbolSlug || !timeframeSlug) {
      continue;
    }
    candidates.add(`${LOCKED_DATASET_PUBLIC_ROOT}/${symbolSlug}-${timeframeSlug}-${profileSlug}.json`);
    candidates.add(`${LOCKED_DATASET_PUBLIC_ROOT}/${symbolSlug}-${timeframeSlug}.json`);
  }

  return [...candidates];
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeLockedDatasetPayload(
  payload: unknown,
  input: Required<Pick<LoadLockedDatasetInput, "symbol" | "timeframe" | "profile">> & { venue: string | null; resolvedUrl: string },
): LockedDataset {
  const payloadMap = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as LockedDatasetPayload
    : null;
  const payloadCandles = payloadMap && "candles" in payloadMap ? payloadMap.candles : payload;
  const normalizedSymbol = normalizeInstrument(toStringOrNull(payloadMap?.symbol) || input.symbol);
  const normalizedTimeframe = toStringOrNull(payloadMap?.timeframe) || input.timeframe;
  const normalizedVenue = toStringOrNull(payloadMap?.venue) || input.venue;
  const normalizedProfile = toStringOrNull(payloadMap?.profile) || input.profile;
  const candles = normalizeOhlcvRows(payloadCandles, {
    instrument: normalizedSymbol,
    venue: normalizedVenue || undefined,
    timeframe: normalizedTimeframe,
  });
  const checksum = computeLockedDatasetChecksum(candles);
  const expectedChecksum = toStringOrNull(payloadMap?.checksum);

  if (expectedChecksum && expectedChecksum !== checksum) {
    throw new Error(`locked_dataset_checksum_mismatch:${expectedChecksum}:${checksum}`);
  }

  const defaultKey = `${slugifyDatasetToken(normalizedSymbol)}-${slugifyDatasetToken(normalizedTimeframe)}-${slugifyDatasetToken(normalizedProfile) || "reference"}`;
  return {
    key: toStringOrNull(payloadMap?.key) || defaultKey,
    symbol: normalizedSymbol,
    timeframe: normalizedTimeframe,
    candles,
    checksum,
    venue: normalizedVenue,
    source: toStringOrNull(payloadMap?.source),
    profile: normalizedProfile,
    capturedAt: toStringOrNull(payloadMap?.capturedAt),
    resolvedUrl: input.resolvedUrl,
  };
}

export async function loadLockedDataset(input: LoadLockedDatasetInput): Promise<LockedDataset> {
  const symbol = normalizeInstrument(input.symbol);
  const timeframe = String(input.timeframe || "").trim() || "1m";
  const profile = String(input.profile || "reference").trim() || "reference";
  const venue = input.venue ? String(input.venue).trim() || null : null;
  const candidates = buildLockedDatasetCandidateUrls(symbol, timeframe, profile);

  let lastError: Error | null = null;
  for (const candidateUrl of candidates) {
    try {
      const response = await fetch(candidateUrl, {
        cache: "no-store",
        signal: input.signal,
      });
      if (!response.ok) {
        lastError = new Error(`locked_dataset_http_${response.status}:${candidateUrl}`);
        continue;
      }
      const payload = await response.json();
      const dataset = normalizeLockedDatasetPayload(payload, {
        symbol,
        timeframe,
        profile,
        venue,
        resolvedUrl: candidateUrl,
      });
      if (dataset.candles.length > 0) {
        return dataset;
      }
      lastError = new Error(`locked_dataset_empty:${candidateUrl}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (input.signal?.aborted) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error(`locked_dataset_unavailable:${symbol}:${timeframe}:${profile}`);
}