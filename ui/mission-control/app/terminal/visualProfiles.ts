import institutional from "./profiles/institutional.json";
import tradingview from "./profiles/tradingview.json";
import txtSignature from "./profiles/txt-signature.json";

export type VisualProfileName = "institutional" | "txt-signature" | "tradingview";

export type VisualProfile = {
  name: VisualProfileName;
  label: string;
  palette: {
    up: string;
    down: string;
    wick: string;
    background: string;
    backgroundAccent: string;
    text: string;
    crosshair: string;
    labelBackground: string;
  };
  rendering: {
    bodyOpacity: number;
    verticalGradientPct: number;
    wickWidthPx: number;
    borderWidthPx: number;
    bodyRadiusPx: number;
    antiAliasing: "msaa-4x" | "msaa-8x";
    floatingPositioning: boolean;
    extremeWickGlow: number;
  };
  motion: {
    transitionMs: number;
    easing: string;
    wickAppearanceMs: number;
    bodyInertia: number;
    breathePx: number;
    directionBounce: number;
  };
  perception: {
    intraCandleSmoothing: number;
    horizontalStabilization: number;
    comfortZonePct: number;
    strictBucketAlignment: boolean;
    domWickSmoothing: boolean;
    lastCandleGlow: number;
    wickDomShiftPct: number;
  };
  frame: {
    minFrameMs: number;
  };
};

const VISUAL_PROFILES: Record<VisualProfileName, VisualProfile> = {
  institutional: institutional as VisualProfile,
  "txt-signature": txtSignature as VisualProfile,
  tradingview: tradingview as VisualProfile,
};

export const DEFAULT_VISUAL_PROFILE: VisualProfileName = "txt-signature";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(input: string): { r: number; g: number; b: number } {
  const normalized = input.replace("#", "").trim();
  const hex = normalized.length === 3
    ? normalized.split("").map((char) => `${char}${char}`).join("")
    : normalized;
  const value = Number.parseInt(hex, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

export function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

export function mixColors(left: string, right: string, weight: number): string {
  const ratio = clamp(weight, 0, 1);
  const a = parseHex(left);
  const b = parseHex(right);
  const r = Math.round(a.r + (b.r - a.r) * ratio);
  const g = Math.round(a.g + (b.g - a.g) * ratio);
  const bChannel = Math.round(a.b + (b.b - a.b) * ratio);
  return `#${[r, g, bChannel].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function applyVisualProfile(profileName: VisualProfileName = DEFAULT_VISUAL_PROFILE): VisualProfile {
  return VISUAL_PROFILES[profileName] ?? VISUAL_PROFILES[DEFAULT_VISUAL_PROFILE];
}

export function interpolateVisualProfiles(
  fromName: VisualProfileName,
  toName: VisualProfileName,
  mix: number,
): VisualProfile {
  const ratio = clamp(mix, 0, 1);
  const from = applyVisualProfile(fromName);
  const to = applyVisualProfile(toName);

  return {
    ...from,
    name: ratio < 0.5 ? from.name : to.name,
    label: ratio < 0.5 ? from.label : to.label,
    palette: {
      up: mixColors(from.palette.up, to.palette.up, ratio),
      down: mixColors(from.palette.down, to.palette.down, ratio),
      wick: mixColors(from.palette.wick, to.palette.wick, ratio),
      background: mixColors(from.palette.background, to.palette.background, ratio),
      backgroundAccent: mixColors(from.palette.backgroundAccent, to.palette.backgroundAccent, ratio),
      text: mixColors(from.palette.text, to.palette.text, ratio),
      crosshair: mixColors(from.palette.crosshair, to.palette.crosshair, ratio),
      labelBackground: mixColors(from.palette.labelBackground, to.palette.labelBackground, ratio),
    },
    rendering: {
      bodyOpacity: from.rendering.bodyOpacity + (to.rendering.bodyOpacity - from.rendering.bodyOpacity) * ratio,
      verticalGradientPct: from.rendering.verticalGradientPct + (to.rendering.verticalGradientPct - from.rendering.verticalGradientPct) * ratio,
      wickWidthPx: from.rendering.wickWidthPx + (to.rendering.wickWidthPx - from.rendering.wickWidthPx) * ratio,
      borderWidthPx: from.rendering.borderWidthPx + (to.rendering.borderWidthPx - from.rendering.borderWidthPx) * ratio,
      bodyRadiusPx: from.rendering.bodyRadiusPx + (to.rendering.bodyRadiusPx - from.rendering.bodyRadiusPx) * ratio,
      antiAliasing: ratio < 0.5 ? from.rendering.antiAliasing : to.rendering.antiAliasing,
      floatingPositioning: from.rendering.floatingPositioning || to.rendering.floatingPositioning,
      extremeWickGlow: from.rendering.extremeWickGlow + (to.rendering.extremeWickGlow - from.rendering.extremeWickGlow) * ratio,
    },
    motion: {
      transitionMs: Math.round(from.motion.transitionMs + (to.motion.transitionMs - from.motion.transitionMs) * ratio),
      easing: ratio < 0.5 ? from.motion.easing : to.motion.easing,
      wickAppearanceMs: Math.round(from.motion.wickAppearanceMs + (to.motion.wickAppearanceMs - from.motion.wickAppearanceMs) * ratio),
      bodyInertia: from.motion.bodyInertia + (to.motion.bodyInertia - from.motion.bodyInertia) * ratio,
      breathePx: from.motion.breathePx + (to.motion.breathePx - from.motion.breathePx) * ratio,
      directionBounce: from.motion.directionBounce + (to.motion.directionBounce - from.motion.directionBounce) * ratio,
    },
    perception: {
      intraCandleSmoothing: from.perception.intraCandleSmoothing + (to.perception.intraCandleSmoothing - from.perception.intraCandleSmoothing) * ratio,
      horizontalStabilization: from.perception.horizontalStabilization + (to.perception.horizontalStabilization - from.perception.horizontalStabilization) * ratio,
      comfortZonePct: from.perception.comfortZonePct + (to.perception.comfortZonePct - from.perception.comfortZonePct) * ratio,
      strictBucketAlignment: from.perception.strictBucketAlignment || to.perception.strictBucketAlignment,
      domWickSmoothing: from.perception.domWickSmoothing || to.perception.domWickSmoothing,
      lastCandleGlow: from.perception.lastCandleGlow + (to.perception.lastCandleGlow - from.perception.lastCandleGlow) * ratio,
      wickDomShiftPct: from.perception.wickDomShiftPct + (to.perception.wickDomShiftPct - from.perception.wickDomShiftPct) * ratio,
    },
    frame: {
      minFrameMs: Math.round(from.frame.minFrameMs + (to.frame.minFrameMs - from.frame.minFrameMs) * ratio),
    },
  };
}