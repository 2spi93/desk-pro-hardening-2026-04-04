import type { ChartSnapPriority } from "../../lib/userUiPrefs";

export function buildChartSnapEnabledLabel(
  chartSnapEnabled: boolean,
  chartSnapPriority: ChartSnapPriority,
  chartSnapStateLabel: string | null | undefined,
  chartAtrLocalPct: number,
) {
  if (!chartSnapEnabled) {
    return "FREE DRAG";
  }

  const atrFactor = Math.max(0.52, Math.min(1.14, 1.16 - chartAtrLocalPct * 40));
  return `${chartSnapPriority.toUpperCase()} · ${chartSnapStateLabel || "LIVE/CURSOR/VWAP/ROUND/CANDLE"} · ATRx${atrFactor.toFixed(2)}`;
}

export function buildChartOrderTicketPriceLabels(ticket: { entry: number; sl: number; tp: number }) {
  return {
    entry: ticket.entry.toFixed(2),
    sl: ticket.sl.toFixed(2),
    tp: ticket.tp.toFixed(2),
  };
}