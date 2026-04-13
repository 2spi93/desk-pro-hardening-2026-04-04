"use client";

import { useCallback, useEffect, useState } from "react";

export type UiMode = "novice" | "expert";
export type ChartMotionPreset = "stable" | "balanced" | "aggressive" | "scalping" | "swing" | "auto";
export type ChartSnapEnabled = boolean;
export type ChartSnapPriority = "execution" | "vwap" | "liquidity";
export type ChartReleaseSendMode = "one-click" | "confirm-required";
export type ChartHapticMode = "off" | "light" | "medium";
export type TerminalChartBarModePreference = "time" | "delta" | "event";
export type TerminalDeskViewModePreference = "auto" | "flow" | "hybrid" | "candle";
export type TerminalLayoutProfileMap = Record<string, Record<string, unknown>>;
export type UserUiPreferencesProfile = {
  uiMode: UiMode;
  chartMotionPreset: ChartMotionPreset;
  chartSnapEnabled: boolean;
  chartSnapPriority: ChartSnapPriority;
  chartReleaseSendMode: ChartReleaseSendMode;
  chartHapticMode: ChartHapticMode;
  terminalDeskViewMode?: TerminalDeskViewModePreference;
  terminalChartBarModeBySymbol?: Record<string, TerminalChartBarModePreference>;
  terminalLayoutByAccount?: TerminalLayoutProfileMap;
  terminalWorkspacesByAccount?: TerminalLayoutProfileMap;
  terminalFloatingPresetsByAccount?: TerminalLayoutProfileMap;
};

export type BackendUserUiPreferencesResponse = {
  preferences: Partial<UserUiPreferencesProfile>;
  updatedAt: string | null;
};

export type SaveBackendUserUiPreferencesResult = {
  ok: boolean;
  status: number;
  updatedAt: string | null;
  preferences: Partial<UserUiPreferencesProfile> | null;
  conflict: boolean;
};

const UI_MODE_STORAGE_KEY = "gtixt.ui.mode.v1";
const CHART_MOTION_PRESET_STORAGE_KEY = "gtixt.chart.motion.preset.v1";
const CHART_SNAP_ENABLED_STORAGE_KEY = "gtixt.chart.snap.enabled.v1";
const CHART_SNAP_PRIORITY_STORAGE_KEY = "gtixt.chart.snap.priority.v1";
const CHART_RELEASE_SEND_MODE_STORAGE_KEY = "gtixt.chart.release.send-mode.v1";
const CHART_HAPTIC_MODE_STORAGE_KEY = "gtixt.chart.haptic.mode.v1";
const TERMINAL_DESK_VIEW_MODE_STORAGE_KEY = "gtixt.terminal.desk-view-mode.v1";
const TERMINAL_CHART_BAR_MODE_BY_SYMBOL_STORAGE_KEY = "gtixt.terminal.chart-bar-mode.by-symbol.v1";
const USER_UI_PREFS_LOCAL_UPDATED_AT_KEY = "gtixt.ui.prefs.updated-at.v1";
const BACKEND_PREFS_FETCH_DEDUPE_MS = 2000;

let backendPrefsInFlight: Promise<BackendUserUiPreferencesResponse | null> | null = null;
let backendPrefsCache: { at: number; payload: BackendUserUiPreferencesResponse | null } | null = null;

function normalizeChartMotionPreset(preset: string | null | undefined): ChartMotionPreset {
  if (preset === "aggressive") return "scalping";
  if (preset === "stable") return "swing";
  if (preset === "balanced") return "auto";
  if (preset === "scalping" || preset === "swing" || preset === "auto") return preset;
  return "auto";
}

function normalizeTerminalChartBarMode(mode: string | null | undefined): TerminalChartBarModePreference {
  return mode === "delta" || mode === "event" ? mode : "time";
}

function normalizeTerminalDeskViewMode(mode: string | null | undefined): TerminalDeskViewModePreference {
  return mode === "flow" || mode === "hybrid" || mode === "candle" ? mode : "auto";
}

function normalizeTerminalChartBarModeSymbol(symbol: string | null | undefined): string {
  return String(symbol || "").trim().toUpperCase();
}

function readStoredTerminalChartBarModeMap(): Record<string, TerminalChartBarModePreference> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TERMINAL_CHART_BAR_MODE_BY_SYMBOL_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed || {}).reduce<Record<string, TerminalChartBarModePreference>>((acc, [symbol, value]) => {
      const normalizedSymbol = normalizeTerminalChartBarModeSymbol(symbol);
      if (!normalizedSymbol) {
        return acc;
      }
      acc[normalizedSymbol] = normalizeTerminalChartBarMode(String(value || "time"));
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function setStoredTerminalChartBarModeMap(value: Record<string, TerminalChartBarModePreference>): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(TERMINAL_CHART_BAR_MODE_BY_SYMBOL_STORAGE_KEY, JSON.stringify(value));
  }
  touchLocalPrefsUpdatedAt();
}

function applyMode(mode: UiMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-ui-mode", mode);
}

function touchLocalPrefsUpdatedAt(): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(USER_UI_PREFS_LOCAL_UPDATED_AT_KEY, new Date().toISOString());
  }
}

export function readLocalUserUiPreferencesUpdatedAt(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(USER_UI_PREFS_LOCAL_UPDATED_AT_KEY);
}

export function setLocalUserUiPreferencesUpdatedAt(value: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(USER_UI_PREFS_LOCAL_UPDATED_AT_KEY, value);
  }
}

function setStoredUiMode(mode: UiMode): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(UI_MODE_STORAGE_KEY, mode);
  }
  applyMode(mode);
  touchLocalPrefsUpdatedAt();
}

function setStoredChartMotionPreset(preset: ChartMotionPreset): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CHART_MOTION_PRESET_STORAGE_KEY, preset);
  }
  touchLocalPrefsUpdatedAt();
}

export function readStoredChartSnapEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(CHART_SNAP_ENABLED_STORAGE_KEY);
  return raw !== "0";
}

function setStoredChartSnapEnabled(value: boolean): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CHART_SNAP_ENABLED_STORAGE_KEY, value ? "1" : "0");
  }
  touchLocalPrefsUpdatedAt();
}

function setStoredChartSnapPriority(value: ChartSnapPriority): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CHART_SNAP_PRIORITY_STORAGE_KEY, value);
  }
  touchLocalPrefsUpdatedAt();
}

function setStoredChartReleaseSendMode(value: ChartReleaseSendMode): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CHART_RELEASE_SEND_MODE_STORAGE_KEY, value);
  }
  touchLocalPrefsUpdatedAt();
}

function setStoredChartHapticMode(value: ChartHapticMode): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CHART_HAPTIC_MODE_STORAGE_KEY, value);
  }
  touchLocalPrefsUpdatedAt();
}

export function readStoredTerminalDeskViewMode(): TerminalDeskViewModePreference {
  if (typeof window === "undefined") return "auto";
  return normalizeTerminalDeskViewMode(window.localStorage.getItem(TERMINAL_DESK_VIEW_MODE_STORAGE_KEY));
}

export function setStoredTerminalDeskViewMode(value: TerminalDeskViewModePreference): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(TERMINAL_DESK_VIEW_MODE_STORAGE_KEY, normalizeTerminalDeskViewMode(value));
  }
  touchLocalPrefsUpdatedAt();
}

export function readStoredTerminalChartBarMode(symbol: string): TerminalChartBarModePreference {
  const normalizedSymbol = normalizeTerminalChartBarModeSymbol(symbol);
  if (!normalizedSymbol) {
    return "time";
  }
  return readStoredTerminalChartBarModeMap()[normalizedSymbol] || "time";
}

export function readStoredTerminalChartBarModes(): Record<string, TerminalChartBarModePreference> {
  return readStoredTerminalChartBarModeMap();
}

export function setStoredTerminalChartBarMode(symbol: string, mode: TerminalChartBarModePreference): void {
  const normalizedSymbol = normalizeTerminalChartBarModeSymbol(symbol);
  if (!normalizedSymbol) {
    return;
  }
  const next = {
    ...readStoredTerminalChartBarModeMap(),
    [normalizedSymbol]: normalizeTerminalChartBarMode(mode),
  };
  setStoredTerminalChartBarModeMap(next);
}

export function readStoredUiMode(): UiMode {
  if (typeof window === "undefined") return "expert";
  const raw = window.localStorage.getItem(UI_MODE_STORAGE_KEY);
  return raw === "novice" ? "novice" : "expert";
}

export function useUiMode(): [UiMode, (mode: UiMode) => void] {
  const [mode, setMode] = useState<UiMode>("expert");

  useEffect(() => {
    const next = readStoredUiMode();
    setMode(next);
    applyMode(next);
  }, []);

  const update = useCallback((next: UiMode) => {
    setMode(next);
    setStoredUiMode(next);
  }, []);

  return [mode, update];
}

export function readStoredChartMotionPreset(): ChartMotionPreset {
  if (typeof window === "undefined") return "auto";
  const raw = window.localStorage.getItem(CHART_MOTION_PRESET_STORAGE_KEY);
  return normalizeChartMotionPreset(raw);
}

export function useChartMotionPreset(): [ChartMotionPreset, (preset: ChartMotionPreset) => void] {
  const [preset, setPreset] = useState<ChartMotionPreset>("auto");

  useEffect(() => {
    setPreset(readStoredChartMotionPreset());
  }, []);

  const update = useCallback((next: ChartMotionPreset) => {
    setPreset(next);
    setStoredChartMotionPreset(next);
  }, []);

  return [preset, update];
}

export function useChartSnapEnabled(): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    setEnabled(readStoredChartSnapEnabled());
  }, []);

  const update = useCallback((next: boolean) => {
    setEnabled(next);
    setStoredChartSnapEnabled(next);
  }, []);

  return [enabled, update];
}

export function readStoredChartSnapPriority(): ChartSnapPriority {
  if (typeof window === "undefined") return "execution";
  const raw = window.localStorage.getItem(CHART_SNAP_PRIORITY_STORAGE_KEY);
  if (raw === "vwap" || raw === "liquidity") {
    return raw;
  }
  return "execution";
}

export function useChartSnapPriority(): [ChartSnapPriority, (value: ChartSnapPriority) => void] {
  const [priority, setPriority] = useState<ChartSnapPriority>("execution");

  useEffect(() => {
    setPriority(readStoredChartSnapPriority());
  }, []);

  const update = useCallback((next: ChartSnapPriority) => {
    setPriority(next);
    setStoredChartSnapPriority(next);
  }, []);

  return [priority, update];
}

export function readStoredChartReleaseSendMode(): ChartReleaseSendMode {
  if (typeof window === "undefined") return "confirm-required";
  const raw = window.localStorage.getItem(CHART_RELEASE_SEND_MODE_STORAGE_KEY);
  return raw === "one-click" ? "one-click" : "confirm-required";
}

export function useChartReleaseSendMode(): [ChartReleaseSendMode, (value: ChartReleaseSendMode) => void] {
  const [mode, setMode] = useState<ChartReleaseSendMode>("confirm-required");

  useEffect(() => {
    setMode(readStoredChartReleaseSendMode());
  }, []);

  const update = useCallback((next: ChartReleaseSendMode) => {
    setMode(next);
    setStoredChartReleaseSendMode(next);
  }, []);

  return [mode, update];
}

export function readStoredChartHapticMode(): ChartHapticMode {
  if (typeof window === "undefined") return "light";
  const raw = window.localStorage.getItem(CHART_HAPTIC_MODE_STORAGE_KEY);
  if (raw === "off" || raw === "medium") {
    return raw;
  }
  return "light";
}

export function useChartHapticMode(): [ChartHapticMode, (value: ChartHapticMode) => void] {
  const [mode, setMode] = useState<ChartHapticMode>("light");

  useEffect(() => {
    setMode(readStoredChartHapticMode());
  }, []);

  const update = useCallback((next: ChartHapticMode) => {
    setMode(next);
    setStoredChartHapticMode(next);
  }, []);

  return [mode, update];
}

export function readLocalUserUiPreferences(): UserUiPreferencesProfile {
  return {
    uiMode: readStoredUiMode(),
    chartMotionPreset: readStoredChartMotionPreset(),
    chartSnapEnabled: readStoredChartSnapEnabled(),
    chartSnapPriority: readStoredChartSnapPriority(),
    chartReleaseSendMode: readStoredChartReleaseSendMode(),
    chartHapticMode: readStoredChartHapticMode(),
    terminalDeskViewMode: readStoredTerminalDeskViewMode(),
    terminalChartBarModeBySymbol: readStoredTerminalChartBarModes(),
  };
}

export function applyLocalUserUiPreferences(profile: Partial<UserUiPreferencesProfile>): void {
  if (profile.uiMode === "novice" || profile.uiMode === "expert") {
    setStoredUiMode(profile.uiMode);
  }
  if (
    profile.chartMotionPreset === "stable"
    || profile.chartMotionPreset === "balanced"
    || profile.chartMotionPreset === "aggressive"
    || profile.chartMotionPreset === "scalping"
    || profile.chartMotionPreset === "swing"
    || profile.chartMotionPreset === "auto"
  ) {
    setStoredChartMotionPreset(normalizeChartMotionPreset(profile.chartMotionPreset));
  }
  if (typeof profile.chartSnapEnabled === "boolean") {
    setStoredChartSnapEnabled(profile.chartSnapEnabled);
  }
  if (profile.chartSnapPriority === "execution" || profile.chartSnapPriority === "vwap" || profile.chartSnapPriority === "liquidity") {
    setStoredChartSnapPriority(profile.chartSnapPriority);
  }
  if (profile.chartReleaseSendMode === "one-click" || profile.chartReleaseSendMode === "confirm-required") {
    setStoredChartReleaseSendMode(profile.chartReleaseSendMode);
  }
  if (profile.chartHapticMode === "off" || profile.chartHapticMode === "light" || profile.chartHapticMode === "medium") {
    setStoredChartHapticMode(profile.chartHapticMode);
  }
  if (
    profile.terminalDeskViewMode === "auto"
    || profile.terminalDeskViewMode === "flow"
    || profile.terminalDeskViewMode === "hybrid"
    || profile.terminalDeskViewMode === "candle"
  ) {
    setStoredTerminalDeskViewMode(profile.terminalDeskViewMode);
  }
  if (profile.terminalChartBarModeBySymbol && typeof profile.terminalChartBarModeBySymbol === "object") {
    const normalized = Object.entries(profile.terminalChartBarModeBySymbol).reduce<Record<string, TerminalChartBarModePreference>>((acc, [symbol, mode]) => {
      const normalizedSymbol = normalizeTerminalChartBarModeSymbol(symbol);
      if (!normalizedSymbol) {
        return acc;
      }
      acc[normalizedSymbol] = normalizeTerminalChartBarMode(String(mode || "time"));
      return acc;
    }, {});
    setStoredTerminalChartBarModeMap(normalized);
  }
}

export async function fetchBackendUserUiPreferences(): Promise<BackendUserUiPreferencesResponse | null> {
  const now = Date.now();
  if (backendPrefsCache && now - backendPrefsCache.at < BACKEND_PREFS_FETCH_DEDUPE_MS) {
    return backendPrefsCache.payload;
  }
  if (backendPrefsInFlight) {
    return backendPrefsInFlight;
  }

  backendPrefsInFlight = (async () => {
    const response = await fetch("/api/auth/preferences", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const preferences = (payload?.preferences || payload || {}) as Partial<UserUiPreferencesProfile>;
    const updatedAt = typeof payload?.updated_at === "string"
      ? payload.updated_at
      : (typeof payload?.updatedAt === "string" ? payload.updatedAt : null);
    return { preferences, updatedAt };
  })();

  try {
    const payload = await backendPrefsInFlight;
    backendPrefsCache = { at: Date.now(), payload };
    return payload;
  } finally {
    backendPrefsInFlight = null;
  }
}

export async function saveBackendUserUiPreferences(
  profile: UserUiPreferencesProfile,
  options?: { baseUpdatedAt?: string | null; clientUpdatedAt?: string | null },
): Promise<SaveBackendUserUiPreferencesResult> {
  backendPrefsCache = null;
  const response = await fetch("/api/auth/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preferences: profile,
      base_updated_at: options?.baseUpdatedAt || null,
      client_updated_at: options?.clientUpdatedAt || null,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  const updatedAt = typeof payload?.updated_at === "string"
    ? payload.updated_at
    : (typeof payload?.updatedAt === "string" ? payload.updatedAt : null);
  const preferences = (payload?.preferences && typeof payload.preferences === "object")
    ? payload.preferences as Partial<UserUiPreferencesProfile>
    : null;
  return {
    ok: response.ok,
    status: response.status,
    updatedAt,
    preferences,
    conflict: response.status === 409,
  };
}