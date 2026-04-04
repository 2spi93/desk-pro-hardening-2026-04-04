import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";

export type CameraState = {
  min: number;
  max: number;
};

const HYSTERESIS = 0.15;
const SMOOTHING_FAST = 0.25;
const SMOOTHING_SLOW = 0.08;
const MICRO_SMOOTH_FAST = 0.12;
const MICRO_SMOOTH_SLOW = 0.1;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function resolveCameraSmoothingAlpha(timeframe: string): number {
  return timeframe.includes("1m") || timeframe.includes("s")
    ? SMOOTHING_FAST
    : SMOOTHING_SLOW;
}

function resolveProfileStabilization(profileName: VisualProfileName): number {
  return applyVisualProfile(profileName).perception.horizontalStabilization;
}

export function smoothCamera(
  current: CameraState,
  target: CameraState,
  timeframe: string,
  profileName: VisualProfileName = DEFAULT_VISUAL_PROFILE,
): CameraState {
  const stabilization = resolveProfileStabilization(profileName);
  const alpha = timeframe.includes("1m") || timeframe.includes("s")
    ? MICRO_SMOOTH_FAST
    : MICRO_SMOOTH_SLOW;
  const adjustedAlpha = alpha * (0.82 + (1 - stabilization) * 0.35);

  return {
    min: lerp(current.min, target.min, adjustedAlpha),
    max: lerp(current.max, target.max, adjustedAlpha),
  };
}

export function updateCamera(
  current: CameraState,
  targetMin: number,
  targetMax: number,
  timeframe: string,
  profileName: VisualProfileName = DEFAULT_VISUAL_PROFILE,
): CameraState {
  const stabilization = resolveProfileStabilization(profileName);
  const range = Math.max(1e-9, current.max - current.min);
  const center = (current.max + current.min) * 0.5;
  const newCenter = (targetMax + targetMin) * 0.5;
  const drift = Math.abs(newCenter - center);
  const driftRatio = drift / range;
  const safeZone = range * Math.max(HYSTERESIS, stabilization * 0.5);

  if (drift < safeZone) {
    return current;
  }

  const baseAlpha = resolveCameraSmoothingAlpha(timeframe);
  const alpha = driftRatio <= 0.08
    ? baseAlpha * 0.55
    : driftRatio <= 0.2
      ? baseAlpha * 0.82
      : Math.max(baseAlpha, 0.42);

  const primary = {
    min: lerp(current.min, targetMin, alpha),
    max: lerp(current.max, targetMax, alpha),
  };

  return smoothCamera(current, primary, timeframe, profileName);
}