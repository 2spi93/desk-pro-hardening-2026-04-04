/**
 * UI Density Intelligence — V3 Render Perception Engine.
 *
 * Maps candle-step-px (pixels per visible candle) to a density level.
 * Used to hide overlays / simplify UI when zoomed out, reveal full
 * detail when zoomed in — exactly the way TradingView does it.
 *
 * micro    < 3 px  per candle → hide everything, just the price line
 * compact  3–7 px              → key labels only, no badges
 * normal   7–18 px             → full UI, no inline tooltips
 * expanded > 18 px             → full UI + inline price detail
 */

export type DensityLevel = "micro" | "compact" | "normal" | "expanded";

export function getDensityLevel(candleStepPx: number): DensityLevel {
  if (candleStepPx < 3) return "micro";
  if (candleStepPx < 7) return "compact";
  if (candleStepPx < 18) return "normal";
  return "expanded";
}

export type DensityConfig = {
  /** Show FVG / OB / liquidity zone badges */
  showBadges: boolean;
  /** Show Asia / London / New York session bands */
  showSessionBands: boolean;
  /** Show the forming-candle DOM overlay */
  showFormingCandle: boolean;
  /** CSS-level alpha for the overlay layer (0–1) */
  overlayAlpha: number;
  /** Scale factor for badge font-size / padding */
  badgeScale: number;
};

export function getDensityConfig(level: DensityLevel): DensityConfig {
  switch (level) {
    case "micro":
      return {
        showBadges: false,
        showSessionBands: false,
        showFormingCandle: false,
        overlayAlpha: 0,
        badgeScale: 0,
      };
    case "compact":
      return {
        showBadges: true,
        showSessionBands: true,
        showFormingCandle: false,
        overlayAlpha: 0.48,
        badgeScale: 0.72,
      };
    case "normal":
      return {
        showBadges: true,
        showSessionBands: true,
        showFormingCandle: true,
        overlayAlpha: 0.88,
        badgeScale: 1,
      };
    case "expanded":
      return {
        showBadges: true,
        showSessionBands: true,
        showFormingCandle: true,
        overlayAlpha: 1,
        badgeScale: 1,
      };
  }
}
