"use client";

import { useEffect, useRef, useState } from "react";

import TxtMiniGuide from "../../components/ui/TxtMiniGuide";
import {
  applyLocalUserUiPreferences,
  fetchBackendUserUiPreferences,
  readLocalUserUiPreferencesUpdatedAt,
  readLocalUserUiPreferences,
  saveBackendUserUiPreferences,
  setLocalUserUiPreferencesUpdatedAt,
  useChartHapticMode,
  useChartMotionPreset,
  useChartReleaseSendMode,
  useChartSnapEnabled,
  useChartSnapPriority,
  useUiMode,
} from "../../lib/userUiPrefs";
import type { UserUiPreferencesProfile } from "../../lib/userUiPrefs";

function toV41MotionPreset(preset: string): "scalping" | "swing" | "auto" {
  if (preset === "aggressive") return "scalping";
  if (preset === "stable") return "swing";
  if (preset === "balanced") return "auto";
  if (preset === "scalping" || preset === "swing" || preset === "auto") return preset;
  return "auto";
}

export default function SettingsPage() {
  const [uiMode, setUiMode] = useUiMode();
  const [chartMotionPreset, setChartMotionPreset] = useChartMotionPreset();
  const [chartSnapEnabled, setChartSnapEnabled] = useChartSnapEnabled();
  const [chartSnapPriority, setChartSnapPriority] = useChartSnapPriority();
  const [chartReleaseSendMode, setChartReleaseSendMode] = useChartReleaseSendMode();
  const [chartHapticMode, setChartHapticMode] = useChartHapticMode();
  const appliedPresetFromQueryRef = useRef<string | null>(null);
  const backendPrefsReadyRef = useRef(false);
  const backendUpdatedAtRef = useRef<string | null>(null);
  const backendPrefsRef = useRef<Partial<UserUiPreferencesProfile> | null>(null);
  const [prefsSyncState, setPrefsSyncState] = useState<"syncing" | "synced" | "local-only">("syncing");
  const [prefsLastSyncedAt, setPrefsLastSyncedAt] = useState<string | null>(null);
  const [prefsTimestampSource, setPrefsTimestampSource] = useState<"backend" | "local-fallback" | null>(null);
  const [prefsSyncReason, setPrefsSyncReason] = useState<string>("initial_sync");

  useEffect(() => {
    let cancelled = false;
    void fetchBackendUserUiPreferences().then((payload) => {
      if (cancelled || !payload) {
        backendPrefsReadyRef.current = true;
        setPrefsSyncState("local-only");
        setPrefsTimestampSource("local-fallback");
        setPrefsSyncReason("backend_unavailable");
        return;
      }
      const profile = payload.preferences;
      backendUpdatedAtRef.current = payload.updatedAt;
      if (payload.updatedAt) {
        setPrefsLastSyncedAt(payload.updatedAt);
        setLocalUserUiPreferencesUpdatedAt(payload.updatedAt);
        setPrefsTimestampSource("backend");
        setPrefsSyncReason("backend_snapshot_loaded");
      }
      backendPrefsRef.current = profile;
      applyLocalUserUiPreferences(profile);
      if (profile.uiMode === "novice" || profile.uiMode === "expert") {
        setUiMode(profile.uiMode);
      }
      if (
        profile.chartMotionPreset === "stable"
        || profile.chartMotionPreset === "balanced"
        || profile.chartMotionPreset === "aggressive"
        || profile.chartMotionPreset === "scalping"
        || profile.chartMotionPreset === "swing"
        || profile.chartMotionPreset === "auto"
      ) {
        setChartMotionPreset(toV41MotionPreset(profile.chartMotionPreset));
      }
      if (typeof profile.chartSnapEnabled === "boolean") {
        setChartSnapEnabled(profile.chartSnapEnabled);
      }
      if (profile.chartSnapPriority === "execution" || profile.chartSnapPriority === "vwap" || profile.chartSnapPriority === "liquidity") {
        setChartSnapPriority(profile.chartSnapPriority);
      }
      if (profile.chartReleaseSendMode === "one-click" || profile.chartReleaseSendMode === "confirm-required") {
        setChartReleaseSendMode(profile.chartReleaseSendMode);
      }
      if (profile.chartHapticMode === "off" || profile.chartHapticMode === "light" || profile.chartHapticMode === "medium") {
        setChartHapticMode(profile.chartHapticMode);
      }
      backendPrefsReadyRef.current = true;
      setPrefsSyncState("synced");
    }).catch(() => {
      backendPrefsReadyRef.current = true;
      setPrefsSyncState("local-only");
      setPrefsTimestampSource("local-fallback");
      setPrefsSyncReason("network_fallback");
    });
    return () => {
      cancelled = true;
    };
  // Initial backend snapshot load only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const presetFromQuery = new URLSearchParams(window.location.search).get("chartPreset");
    if (!presetFromQuery || appliedPresetFromQueryRef.current === presetFromQuery) {
      return;
    }
    if (
      presetFromQuery === "stable"
      || presetFromQuery === "balanced"
      || presetFromQuery === "aggressive"
      || presetFromQuery === "scalping"
      || presetFromQuery === "swing"
      || presetFromQuery === "auto"
    ) {
      setChartMotionPreset(toV41MotionPreset(presetFromQuery));
      appliedPresetFromQueryRef.current = presetFromQuery;
    }
  }, [setChartMotionPreset]);

  useEffect(() => {
    if (!backendPrefsReadyRef.current) {
      return;
    }
    setPrefsSyncState("syncing");
    const clientUpdatedAt = new Date().toISOString();
    const nextProfile = {
      ...(backendPrefsRef.current || {}),
      ...readLocalUserUiPreferences(),
    };
    backendPrefsRef.current = nextProfile;
    void saveBackendUserUiPreferences(nextProfile, {
      baseUpdatedAt: backendUpdatedAtRef.current,
      clientUpdatedAt,
    }).then((result) => {
      if (result.ok) {
        backendUpdatedAtRef.current = result.updatedAt;
        if (result.updatedAt) {
          setPrefsLastSyncedAt(result.updatedAt);
          setLocalUserUiPreferencesUpdatedAt(result.updatedAt);
          setPrefsTimestampSource("backend");
          setPrefsSyncReason("backend_commit_ok");
        }
        setPrefsSyncState("synced");
        return;
      }
      if (result.conflict && result.preferences) {
        backendPrefsRef.current = result.preferences;
        applyLocalUserUiPreferences(result.preferences);
        if (result.updatedAt) {
          backendUpdatedAtRef.current = result.updatedAt;
          setPrefsLastSyncedAt(result.updatedAt);
          setLocalUserUiPreferencesUpdatedAt(result.updatedAt);
          setPrefsTimestampSource("backend");
          setPrefsSyncReason("backend_newer_conflict_resolved");
        }
        setPrefsSyncState("synced");
        return;
      }
      const fallbackLocalTs = readLocalUserUiPreferencesUpdatedAt() || clientUpdatedAt;
      setPrefsLastSyncedAt(fallbackLocalTs);
      setPrefsTimestampSource("local-fallback");
      setPrefsSyncReason("save_failed_local_fallback");
      setPrefsSyncState("local-only");
    }).catch(() => {
      const fallbackLocalTs = readLocalUserUiPreferencesUpdatedAt() || clientUpdatedAt;
      setPrefsLastSyncedAt(fallbackLocalTs);
      setPrefsTimestampSource("local-fallback");
      setPrefsSyncReason("network_fallback");
      setPrefsSyncState("local-only");
    });
  }, [uiMode, chartMotionPreset, chartSnapEnabled, chartSnapPriority, chartReleaseSendMode, chartHapticMode]);

  const formatSyncTimestamp = (value: string | null): string => {
    if (!value) {
      return "--";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString();
  };

  const compactSyncReasonLabel = (reason: string): string => {
    switch (reason) {
      case "backend_newer_conflict_resolved":
        return "conflict_resolved";
      case "network_fallback":
        return "network_fallback";
      case "backend_commit_ok":
        return "commit_ok";
      case "backend_snapshot_loaded":
        return "snapshot_loaded";
      case "save_failed_local_fallback":
        return "save_failed";
      case "backend_unavailable":
        return "backend_unavailable";
      case "initial_sync":
        return "initial_sync";
      default:
        return reason || "unknown";
    }
  };

  const syncReasonTooltip = (reason: string): string => {
    switch (reason) {
      case "backend_newer_conflict_resolved":
        return "Backend timestamp was newer than local base; server version won and was reapplied locally.";
      case "network_fallback":
        return "Network/API unavailable during sync; local preferences retained as fallback.";
      case "backend_commit_ok":
        return "Preferences successfully committed to backend profile.";
      case "backend_snapshot_loaded":
        return "Backend snapshot loaded on page init and applied locally.";
      case "save_failed_local_fallback":
        return "Save attempt failed; local preferences retained without backend confirmation.";
      case "backend_unavailable":
        return "Backend preferences endpoint unavailable at load time.";
      case "initial_sync":
        return "Initial sync sequence in progress.";
      default:
        return reason || "No sync reason available.";
    }
  };

  return (
    <main className="shell txt-page-shell">
      <section className="panel txt-page-hero">
        <div className="eyebrow">TXT Settings</div>
        <h1 className="title" style={{ fontSize: 34 }}>Parametres globaux</h1>
        <p className="subtle">Personnalise l'experience TXT: densite, mode novice/expert et preferences d'interface.</p>
        <div className={`txt-prefs-sync-badge ${prefsSyncState === "synced" ? "synced" : prefsSyncState === "local-only" ? "local-only" : "syncing"}`}>
          {prefsSyncState === "synced" ? "prefs synced" : prefsSyncState === "local-only" ? "fallback local only" : "syncing prefs"}
        </div>
        <div className="txt-prefs-sync-ts-row">
          <div className="txt-prefs-sync-ts">last synced: {formatSyncTimestamp(prefsLastSyncedAt)}</div>
          <span className={`txt-prefs-sync-source ${prefsTimestampSource === "backend" ? "backend" : "local-fallback"}`}>
            source: {prefsTimestampSource === "backend" ? "backend" : "local fallback"}
          </span>
          <span
            className="txt-prefs-sync-reason"
            title={syncReasonTooltip(prefsSyncReason)}
          >
            reason: {compactSyncReasonLabel(prefsSyncReason)}
          </span>
        </div>
        <TxtMiniGuide
          title="Guide Settings"
          what="Controle du mode d'affichage et des preferences de layout TXT."
          why="Adapter l'interface a ton niveau sans perdre la profondeur du terminal."
          example="Passe en Novice pour apprendre les modules, puis en Expert pour accelerer l'execution."
        />
      </section>

      <section className="panel">
        <div className="row">
          <span>Mode d'affichage</span>
          <div className="txt-settings-toggle" role="tablist" aria-label="UI mode">
            <button type="button" className={`txt-settings-mode-btn${uiMode === "novice" ? " active" : ""}`} onClick={() => setUiMode("novice")}>Novice</button>
            <button type="button" className={`txt-settings-mode-btn${uiMode === "expert" ? " active" : ""}`} onClick={() => setUiMode("expert")}>Expert</button>
          </div>
        </div>
        <div className="row">
          <span>Layout panels</span>
          <span className="subtle">Resizable / draggable en cours de generalisation</span>
        </div>
        <div id="chart-motion-preset" className="row">
          <span>Chart engine</span>
          <div className="txt-settings-toggle" role="tablist" aria-label="Chart motion preset">
            <button
              type="button"
              className={`txt-settings-mode-btn${chartMotionPreset === "scalping" ? " active" : ""}`}
              onClick={() => setChartMotionPreset("scalping")}
            >
              Scalping
            </button>
            <button
              type="button"
              className={`txt-settings-mode-btn${chartMotionPreset === "swing" ? " active" : ""}`}
              onClick={() => setChartMotionPreset("swing")}
            >
              Swing
            </button>
            <button
              type="button"
              className={`txt-settings-mode-btn${chartMotionPreset === "auto" ? " active" : ""}`}
              onClick={() => setChartMotionPreset("auto")}
            >
              Auto
            </button>
          </div>
        </div>
        <div className="row">
          <span>Snap on chart</span>
          <div className="txt-settings-toggle" role="tablist" aria-label="Chart snap enabled">
            <button type="button" className={`txt-settings-mode-btn${chartSnapEnabled ? " active" : ""}`} onClick={() => setChartSnapEnabled(true)}>On</button>
            <button type="button" className={`txt-settings-mode-btn${!chartSnapEnabled ? " active" : ""}`} onClick={() => setChartSnapEnabled(false)}>Off</button>
          </div>
        </div>
        <div className="row">
          <span>Snap priority</span>
          <div className="txt-settings-stack">
            <div className="txt-settings-toggle" role="tablist" aria-label="Chart snap priority">
              <button type="button" className={`txt-settings-mode-btn${chartSnapPriority === "execution" ? " active" : ""}`} onClick={() => setChartSnapPriority("execution")}>Execution</button>
              <button type="button" className={`txt-settings-mode-btn${chartSnapPriority === "vwap" ? " active" : ""}`} onClick={() => setChartSnapPriority("vwap")}>VWAP</button>
              <button type="button" className={`txt-settings-mode-btn${chartSnapPriority === "liquidity" ? " active" : ""}`} onClick={() => setChartSnapPriority("liquidity")}>Liquidity</button>
            </div>
            <div className="txt-snap-preview-row" aria-label="Snap family color preview">
              <span className="txt-snap-preview execution">Execution</span>
              <span className="txt-snap-preview vwap">VWAP</span>
              <span className="txt-snap-preview liquidity">Liquidity</span>
            </div>
          </div>
        </div>
        <div className="row">
          <span>Release ticket send</span>
          <div className="txt-settings-toggle" role="tablist" aria-label="Chart release send mode">
            <button type="button" className={`txt-settings-mode-btn${chartReleaseSendMode === "one-click" ? " active" : ""}`} onClick={() => setChartReleaseSendMode("one-click")}>One-click</button>
            <button type="button" className={`txt-settings-mode-btn${chartReleaseSendMode === "confirm-required" ? " active" : ""}`} onClick={() => setChartReleaseSendMode("confirm-required")}>Confirm</button>
          </div>
        </div>
        <div className="row">
          <span>Mobile haptic</span>
          <div className="txt-settings-toggle" role="tablist" aria-label="Chart haptic mode">
            <button type="button" className={`txt-settings-mode-btn${chartHapticMode === "off" ? " active" : ""}`} onClick={() => setChartHapticMode("off")}>Off</button>
            <button type="button" className={`txt-settings-mode-btn${chartHapticMode === "light" ? " active" : ""}`} onClick={() => setChartHapticMode("light")}>Light</button>
            <button type="button" className={`txt-settings-mode-btn${chartHapticMode === "medium" ? " active" : ""}`} onClick={() => setChartHapticMode("medium")}>Medium</button>
          </div>
        </div>
      </section>
    </main>
  );
}