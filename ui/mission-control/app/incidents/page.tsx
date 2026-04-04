"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import HelpHint from "../../components/HelpHint";
import TxtMiniGuide from "../../components/ui/TxtMiniGuide";

type JsonMap = Record<string, unknown>;

function asMap(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asList(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.filter((item): item is JsonMap => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function toneClass(value: string): string {
  if (["ok", "resolved"].includes(value)) {
    return "good";
  }
  if (["degraded", "assigned", "watch"].includes(value)) {
    return "subtle";
  }
  return "warn";
}

export default function IncidentsPage() {
  const [items, setItems] = useState<JsonMap[]>([]);
  const [summary, setSummary] = useState<JsonMap>({});
  const [connectorSummary, setConnectorSummary] = useState<JsonMap[]>([]);
  const [slaMinutes, setSlaMinutes] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("Resolved after review");

  const loadIncidents = useCallback(async (status: string = statusFilter): Promise<void> => {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await fetch(`/api/incidents${suffix}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Impossible de charger les incidents");
    }
    const payload = await response.json();
    setSlaMinutes(Number(payload.sla_minutes || 0));
    setItems((payload.items as JsonMap[] | undefined) || []);
    setSummary(asMap(payload.summary));
    setConnectorSummary(asList(payload.connector_summary));
  }, [statusFilter]);

  useEffect(() => {
    loadIncidents(statusFilter).catch((err) => setError(err instanceof Error ? err.message : "Erreur inconnue"));
    const timer = window.setInterval(() => {
      void loadIncidents(statusFilter);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadIncidents, statusFilter]);

  const slaBreachedCount = items.filter((x) => Boolean(x.sla_breached)).length;
  const visibleItems = items.filter((item) => !providerFilter || String(item.provider || "") === providerFilter);

  async function assignTicket(ticketKey: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(ticketKey)}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(String(payload?.detail || "Assignation impossible"));
      }
      await loadIncidents(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function closeTicket(ticketKey: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(ticketKey)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution_note: resolutionNote }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(String(payload?.detail || "Cloture impossible"));
      }
      await loadIncidents(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Incident Desk <HelpHint text="Console d'incidents: suivi, assignation, cloture, traçabilite operationnelle." examples={["Exemple simple: filtre open, assigne un ticket a toi, corrige, puis close avec une note claire.", "Si un incident touche execution ou broker, ouvre aussi Trading Terminal pour voir l'etat global."]} /></div>
          <h1 className="title" style={{ fontSize: 34 }}>Incidents Operations</h1>
          <p className="subtle">Pilote les incidents ouverts par le chatbot et les operateurs.</p>
          <TxtMiniGuide
            title="Guide Incidents"
            what="Backlog des incidents operationnels avec assignation et cloture tracees."
            why="Reagir vite sans perdre la traçabilite des decisions prises en exploitation."
            example="Prends ownership, investigue la cause, puis close avec une note claire et actionnable."
          />
          <p>
            <Link href="/">Dashboard</Link>
            {" | "}
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/live-readiness">Live Readiness</Link>
            {" | "}
            <Link href="/ai">IA</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Filtres <HelpHint text="Filtre rapide par statut incident." examples={["Choisis open pour traiter d'abord le backlog critique du moment.", "Resolution note sera reutilisee a la cloture, donc ecris directement une phrase utile."]} /></div>
          {slaBreachedCount > 0 ? (
            <p className="warn">Alerte: {slaBreachedCount} incident(s) non assignes au-dela de {slaMinutes} min.</p>
          ) : null}
          <div className="form-grid">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">all</option>
              <option value="open">open</option>
              <option value="assigned">assigned</option>
              <option value="closed">closed</option>
            </select>
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
              <option value="">all connectors</option>
              {connectorSummary.map((item) => (
                <option key={String(item.provider)} value={String(item.provider)}>{String(item.provider)}</option>
              ))}
            </select>
            <button type="button" disabled={busy} onClick={() => void loadIncidents(statusFilter)}>
              {busy ? "Chargement..." : "Appliquer filtre"}
            </button>
            <input value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} placeholder="Resolution note" />
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div className="panel">
          <div className="eyebrow">SLA</div>
          <div className="row"><span>SLA</span><span>{slaMinutes} min</span></div>
          <div className="row"><span>Breach</span><span className={slaBreachedCount > 0 ? "warn" : "good"}>{slaBreachedCount}</span></div>
        </div>
        <div className="panel">
          <div className="eyebrow">Backlog</div>
          <div className="row"><span>Open</span><span>{String(asMap(summary.status).open || 0)}</span></div>
          <div className="row"><span>Assigned</span><span>{String(asMap(summary.status).assigned || 0)}</span></div>
          <div className="row"><span>Closed</span><span>{String(asMap(summary.status).closed || 0)}</span></div>
        </div>
        <div className="panel">
          <div className="eyebrow">Severity</div>
          <div className="row"><span>Critical</span><span className={Number(asMap(summary.severity).critical || 0) > 0 ? "warn" : "good"}>{String(asMap(summary.severity).critical || 0)}</span></div>
          <div className="row"><span>High</span><span>{String(asMap(summary.severity).high || 0)}</span></div>
          <div className="row"><span>Medium / Low</span><span>{Number(asMap(summary.severity).medium || 0) + Number(asMap(summary.severity).low || 0)}</span></div>
        </div>
        <div className="panel">
          <div className="eyebrow">Connector Load</div>
          <div className="row"><span>Connector incidents actifs</span><span>{String(summary.active_connector_incidents || 0)}</span></div>
          <div className="row"><span>Total visibles</span><span>{visibleItems.length}</span></div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
        <div className="panel">
          <div className="eyebrow">Incidents par connecteur</div>
          {connectorSummary.length === 0 ? <p className="subtle">Aucune incidence connecteur detectee.</p> : null}
          {connectorSummary.map((item) => (
            <div className="panel" key={String(item.provider)} style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>{String(item.provider)}</span><span className={toneClass(Number(item.active_count || 0) > 0 ? "degraded" : "ok")}>{Number(item.active_count || 0) > 0 ? "active" : "clean"}</span></div>
              <div className="row"><span>Active / critical</span><span>{String(item.active_count || 0)} / {String(item.critical_count || 0)}</span></div>
              <div className="row"><span>Uptime observe 24h / 7j</span><span>{String(item.uptime_24h_pct || 0)}% / {String(item.uptime_7d_pct || 0)}%</span></div>
              <div className="row"><span>Diagnostic principal</span><span>{String(item.top_diagnostic || "operator-review")}</span></div>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="eyebrow">Degradation History</div>
          {connectorSummary.length === 0 ? <p className="subtle">Aucun historique.</p> : null}
          {connectorSummary.map((item) => (
            <div className="panel" key={`history-${String(item.provider)}`} style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>{String(item.provider)}</span><span>{String(item.last_incident_at || "-")}</span></div>
              <div className="row"><span>Historique</span><span>{asList(item.history).map((entry) => `${String(entry.severity)}:${String(entry.title)}`).join(" | ") || "n/a"}</span></div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Liste incidents <HelpHint text="Assigner un ticket a soi puis le cloturer avec note de resolution." examples={["Assign to me quand tu prends la main sur le sujet.", "Close seulement quand la cause est comprise et que la note de resolution permet a un autre operateur de suivre."]} /></div>
          {visibleItems.length === 0 ? <p className="subtle">Aucun incident.</p> : null}
          {visibleItems.map((item) => {
            const key = String(item.ticket_key || "");
            const status = String(item.status || "");
            const age = Number(item.age_minutes || 0);
            const sla = Boolean(item.sla_breached);
            const degradation = asMap(item.connector_degradation);
            const diagnostics = asStringList(item.diagnostics).join(", ");
            return (
              <div className="panel" key={key} style={{ marginTop: 12, borderRadius: 12 }}>
                <div className="row">
                  <span>{key} | {String(item.severity || "-")} | {String(item.title || "-")}</span>
                  <span className={toneClass(status)}>{status}</span>
                </div>
                <div className="row"><span>Assignee / age / SLA</span><span>{String(item.assignee || "-")} | {age}m | {String(sla)}</span></div>
                <div className="row"><span>Connecteur</span><span>{String(item.provider || "global")}</span></div>
                <div className="row"><span>Diagnostics</span><span>{diagnostics || "operator-review"}</span></div>
                <div className="row"><span>Degradation</span><span>{String(degradation.state || "watch")} | reroute {String(degradation.reroute_target || "n/a")}</span></div>
                <div className="row"><span>Fallback path</span><span>{((degradation.fallback_path as string[] | undefined) || []).join(" -> ") || "n/a"}</span></div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button type="button" disabled={busy || status === "closed"} onClick={() => void assignTicket(key)}>Assign to me</button>
                  <button type="button" disabled={busy || status === "closed"} onClick={() => void closeTicket(key)}>Close</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
