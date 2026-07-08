"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type FreshEpisode = {
  present: boolean;
  fresh: boolean;
  side: string | null;
  status: string | null;
  net_bps: number | null;
  expires_at: string | null;
  seconds_left: number | null;
  episode_key: string | null;
};

type CanarySnapshot = {
  generated_at: string;
  state: "ARMED_WAITING" | "ARM_EXPIRED" | "FIRED" | "FIRE_ERROR" | "DISARMED";
  armed: boolean;
  consumed: boolean;
  expired: boolean;
  seconds_to_expiry: number | null;
  arm: Record<string, unknown> | null;
  fresh_episode: FreshEpisode | null;
  last_outcome: Record<string, unknown> | null;
  notional_note: string;
};

const STATE_LABEL: Record<CanarySnapshot["state"], { label: string; tone: string }> = {
  ARMED_WAITING: { label: "Armé — en attente d'un épisode SELL frais", tone: "good" },
  FIRED: { label: "Cycle exécuté", tone: "good" },
  FIRE_ERROR: { label: "Erreur pendant le cycle", tone: "warn" },
  ARM_EXPIRED: { label: "Expiré — désarmé, aucun ordre", tone: "subtle" },
  DISARMED: { label: "Désarmé", tone: "subtle" },
};

function fmtCountdown(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  if (seconds <= 0) {
    return "expiré";
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export default function CanaryStatusPage() {
  const [snap, setSnap] = useState<CanarySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string>("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/canary/status", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as CanarySnapshot;
        if (active) {
          setSnap(data);
          setError(null);
          setLoadedAt(new Date().toLocaleTimeString());
        }
      } catch (e) {
        if (active) {
          setError(String(e));
        }
      }
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const state = snap?.state ?? "DISARMED";
  const tone = STATE_LABEL[state]?.tone ?? "subtle";
  const label = STATE_LABEL[state]?.label ?? state;
  const arm = snap?.arm ?? null;
  const fresh = snap?.fresh_episode ?? null;
  const outcome = snap?.last_outcome ?? null;

  return (
    <main className="shell txt-page-shell">
      <section className="hero" style={{ display: "grid", gap: 12 }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Proof-renewal canary</div>
          <h1 className="title" style={{ fontSize: 30, marginBottom: 6 }}>
            État du test autonome
          </h1>
          <p className="subtle" style={{ marginBottom: 12 }}>
            Un seul cycle de vente réel (~$6,2), déclenché automatiquement sur un épisode
            SELL frais et 100&nbsp;% vert, puis arrêt. Page en lecture seule.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span
              className={tone}
              style={{
                fontSize: 15,
                fontWeight: 600,
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid currentColor",
                background: "rgba(127,127,127,0.08)",
              }}
            >
              {label}
            </span>
            {state === "ARMED_WAITING" && (
              <span className="subtle">
                Expire dans <strong>{fmtCountdown(snap?.seconds_to_expiry ?? null)}</strong>
              </span>
            )}
          </div>
        </div>
      </section>

      {error && (
        <section className="panel" style={{ marginTop: 12 }}>
          <div className="warn">Statut indisponible: {error}</div>
        </section>
      )}

      <section
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 12 }}
      >
        <div className="panel">
          <div className="eyebrow">Armement</div>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 8 }}>
            <dt className="subtle">Armé</dt>
            <dd className={snap?.armed ? "good" : "subtle"}>{snap?.armed ? "oui" : "non"}</dd>
            <dt className="subtle">Portée</dt>
            <dd>{(arm?.arm_scope as string) ?? "—"}</dd>
            <dt className="subtle">Cycles max</dt>
            <dd>{(arm?.max_cycles as number) ?? "—"}</dd>
            <dt className="subtle">Expire</dt>
            <dd>{(arm?.arm_expires_at as string) ?? "—"}</dd>
            <dt className="subtle">Consommé</dt>
            <dd className={snap?.consumed ? "subtle" : "good"}>{snap?.consumed ? "oui" : "non"}</dd>
          </dl>
        </div>

        <div className="panel">
          <div className="eyebrow">Épisode SELL en cours</div>
          {fresh?.present ? (
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 8 }}>
              <dt className="subtle">Frais</dt>
              <dd className={fresh.fresh ? "good" : "subtle"}>{fresh.fresh ? "oui" : "non (expiré)"}</dd>
              <dt className="subtle">Côté</dt>
              <dd>{fresh.side ?? "—"}</dd>
              <dt className="subtle">Edge net</dt>
              <dd>{fresh.net_bps !== null ? `${fresh.net_bps.toFixed(2)} bps` : "—"}</dd>
              <dt className="subtle">Reste</dt>
              <dd>{fmtCountdown(fresh.seconds_left)}</dd>
            </dl>
          ) : (
            <p className="subtle" style={{ marginTop: 8 }}>Aucun épisode signalé.</p>
          )}
        </div>

        <div className="panel">
          <div className="eyebrow">Dernier résultat</div>
          {outcome ? (
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 8 }}>
              <dt className="subtle">Résultat</dt>
              <dd className={String(outcome.result) === "FIRED" ? "good" : String(outcome.result) === "FIRE_ERROR" ? "warn" : "subtle"}>
                {String(outcome.result ?? "—")}
              </dd>
              <dt className="subtle">Quand</dt>
              <dd>{(outcome.at as string) ?? "—"}</dd>
              {outcome.exit_code !== undefined && (
                <>
                  <dt className="subtle">Code</dt>
                  <dd>{String(outcome.exit_code)}</dd>
                </>
              )}
              {outcome.episode_key !== undefined && (
                <>
                  <dt className="subtle">Épisode</dt>
                  <dd style={{ wordBreak: "break-all", fontSize: 12 }}>{String(outcome.episode_key)}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="subtle" style={{ marginTop: 8 }}>Aucun cycle exécuté à ce jour.</p>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 12 }}>
        <p className="subtle" style={{ margin: 0 }}>
          {snap?.notional_note}
          {" "}Rafraîchi automatiquement toutes les 10&nbsp;s{loadedAt ? ` (dernier: ${loadedAt})` : ""}.
        </p>
        <p className="subtle" style={{ marginTop: 6, marginBottom: 0 }}>
          Retour <Link href="/live-ops">Live Ops</Link> · <Link href="/live-readiness">Readiness</Link>
        </p>
      </section>
    </main>
  );
}
