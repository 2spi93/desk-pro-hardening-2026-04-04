"use client";

import { useEffect, useState } from "react";

import HelpHint from "../../components/HelpHint";

type JsonMap = Record<string, unknown>;

type RiskBudgetState = {
  status: "idle" | "loading" | "ready" | "degraded";
  limitUsd: number | null;
  usedUsd: number | null;
  remainingUsd: number | null;
  policyVersion: string | null;
  paperOnly: boolean | null;
  error: string | null;
};

const INITIAL_RISK_BUDGET: RiskBudgetState = {
  status: "idle",
  limitUsd: null,
  usedUsd: null,
  remainingUsd: null,
  policyVersion: null,
  paperOnly: null,
  error: null,
};

function toFiniteNumber(value: unknown): number | null {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatUsd(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return `${value.toFixed(0)} USD`;
}

export default function RustExecutionAdminDesk() {
  const [accountId, setAccountId] = useState("rust-paper-01");
  const [symbol, setSymbol] = useState("EURUSD");
  const [side, setSide] = useState("buy");
  const [lots, setLots] = useState(0.1);
  const [notionalUsd, setNotionalUsd] = useState(100);
  const [maxSpreadBps, setMaxSpreadBps] = useState(12);
  const [rationale, setRationale] = useState("Paper preset sous seuil policy");
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [executeBusy, setExecuteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<JsonMap | null>(null);
  const [executeResult, setExecuteResult] = useState<JsonMap | null>(null);
  const [riskBudget, setRiskBudget] = useState<RiskBudgetState>(INITIAL_RISK_BUDGET);

  useEffect(() => {
    void refreshRiskBudget();
  }, []);

  async function refreshRiskBudget(): Promise<void> {
    setRiskBudget((current) => ({ ...current, status: "loading", error: null }));
    try {
      const response = await fetch("/api/system/risk-budget", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      const limitUsd = toFiniteNumber(payload?.daily_notional_limit_usd);
      const usedUsd = toFiniteNumber(payload?.daily_notional_used_usd);
      const remainingUsd = toFiniteNumber(payload?.daily_notional_remaining_usd);
      setRiskBudget({
        status: response.ok ? "ready" : "degraded",
        limitUsd,
        usedUsd,
        remainingUsd,
        policyVersion: typeof payload?.policy_version === "string" ? payload.policy_version : null,
        paperOnly: typeof payload?.paper_only === "boolean" ? payload.paper_only : null,
        error: response.ok ? null : "Budget risque indisponible",
      });
    } catch {
      setRiskBudget({
        ...INITIAL_RISK_BUDGET,
        status: "degraded",
        error: "Budget risque indisponible",
      });
    }
  }

  function buildBody(): JsonMap {
    return {
      account_id: accountId,
      symbol,
      side,
      lots,
      estimated_notional_usd: notionalUsd,
      max_spread_bps: maxSpreadBps,
      preferred_venue: "binance-paper",
      rationale,
      route_hint: {
        source: "advanced-admin-paper-preset",
        reason: "internal_dual_venue_debug",
        best: {
          venue: "binance-paper",
          instrument: symbol,
          spread_bps: 4.2,
          available_depth_usd: 5000,
          latency_ms: 8,
          fill_probability: 0.93,
          score: 0.94,
          best_bid: 1.0999,
          best_ask: 1.1001,
          last: 1.1,
        },
        backup: {
          venue: "okx-paper",
          instrument: symbol,
          spread_bps: 5.1,
          available_depth_usd: 4800,
          latency_ms: 10,
          fill_probability: 0.9,
          score: 0.89,
          best_bid: 1.0998,
          best_ask: 1.1002,
          last: 1.1,
        },
        candidates: [
          {
            venue: "binance-paper",
            instrument: symbol,
            spread_bps: 4.2,
            available_depth_usd: 5000,
            latency_ms: 8,
            fill_probability: 0.93,
            score: 0.94,
            best_bid: 1.0999,
            best_ask: 1.1001,
            last: 1.1,
          },
          {
            venue: "okx-paper",
            instrument: symbol,
            spread_bps: 5.1,
            available_depth_usd: 4800,
            latency_ms: 10,
            fill_probability: 0.9,
            score: 0.89,
            best_bid: 1.0998,
            best_ask: 1.1002,
            last: 1.1,
          },
        ],
      },
      market_snapshot: {
        candidate_count: 2,
        deviation_bps: 1.8,
        total_depth_usd: 9800,
        best_bid: 1.0999,
        best_ask: 1.1001,
        buy_venue: "binance-paper",
        sell_venue: "okx-paper",
      },
      metadata: {
        source: "advanced-admin",
        workflow: "rust-execution-desk",
        preset: "paper-dual-venue-debug",
      },
    };
  }

  async function previewRustExecution(): Promise<void> {
    setPreviewBusy(true);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/execution/rust/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Rust preview indisponible"));
      }
      setPreviewResult((payload || null) as JsonMap | null);
      await refreshRiskBudget();
    } catch (err) {
      setPreviewResult(null);
      setError(err instanceof Error ? err.message : "Rust preview indisponible");
    } finally {
      setPreviewBusy(false);
      setBusy(false);
    }
  }

  async function executeRustDebug(): Promise<void> {
    setExecuteBusy(true);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/execution/rust/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Rust execute debug indisponible"));
      }
      setExecuteResult((payload || null) as JsonMap | null);
      await refreshRiskBudget();
    } catch (err) {
      setExecuteResult(null);
      setError(err instanceof Error ? err.message : "Rust execute debug indisponible");
    } finally {
      setExecuteBusy(false);
      setBusy(false);
    }
  }

  const remainingAfterPlannedTest = riskBudget.remainingUsd !== null ? riskBudget.remainingUsd - notionalUsd : null;
  const riskBudgetReady = riskBudget.status === "ready";
  const budgetInsufficient = remainingAfterPlannedTest !== null && remainingAfterPlannedTest < 0;
  const actionsBlocked = busy || !riskBudgetReady || budgetInsufficient;

  return (
    <section className="panel" data-testid="advanced-rust-execution-desk">
      <div className="eyebrow">
        Admin Rust Execution Desk <HelpHint text="Desk interne TXT uniquement pour preview, hedge guard et execute debug." examples={["Le preset paper 100 USD reste compatible avec la policy actuelle meme apres plusieurs validations de test.", "Si l'execute est rejete, lis d'abord le risk gate avant de toucher aux routes ou au moteur Rust."]} />
      </div>
      <p className="subtle" style={{ marginTop: 8 }}>
        Ce panneau est reserve aux pages internes. Le preset par defaut vise un execute paper compatible avec la policy actuelle.
      </p>
      <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
        <div className="row"><span>Daily budget limit</span><span>{formatUsd(riskBudget.limitUsd)}</span></div>
        <div className="row"><span>Daily budget used</span><span>{formatUsd(riskBudget.usedUsd)}</span></div>
        <div className="row"><span>Remaining before test</span><span>{formatUsd(riskBudget.remainingUsd)}</span></div>
        <div className="row"><span>Remaining after planned test</span><span>{formatUsd(remainingAfterPlannedTest)}</span></div>
        <div className="row"><span>Policy</span><span>{riskBudget.policyVersion || "-"}{riskBudget.paperOnly ? " · paper only" : ""}</span></div>
        <p className="subtle" style={{ marginTop: 10, marginBottom: 0 }}>
          Rafraichis ce budget avant tout test Rust. Dans l'etat actuel du backend, le preview consomme aussi le budget risque journalier.
        </p>
        {riskBudget.error ? <p className="warn" style={{ marginTop: 10 }}>{riskBudget.error}</p> : null}
        {budgetInsufficient ? <p className="warn" style={{ marginTop: 10 }}>Budget journalier insuffisant pour ce test avec le notional courant.</p> : null}
        <div className="form-grid" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => refreshRiskBudget()} disabled={riskBudget.status === "loading" || busy}>
            {riskBudget.status === "loading" ? "Refresh budget…" : "Refresh risk budget"}
          </button>
        </div>
      </div>
      {error ? <p className="warn">{error}</p> : null}
      <div className="form-grid" style={{ marginTop: 12 }}>
        <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="account_id" />
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="symbol" />
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
        <input type="number" step="0.01" value={lots} onChange={(e) => setLots(Number(e.target.value || 0))} placeholder="lots" />
        <input type="number" step="1" value={notionalUsd} onChange={(e) => setNotionalUsd(Number(e.target.value || 0))} placeholder="estimated_notional_usd" />
        <input type="number" step="1" value={maxSpreadBps} onChange={(e) => setMaxSpreadBps(Number(e.target.value || 0))} placeholder="max_spread_bps" />
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="rationale" style={{ gridColumn: "1 / -1" }} />
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => previewRustExecution()} disabled={previewBusy || actionsBlocked}>{previewBusy ? "Preview…" : "Preview Rust"}</button>
        <button type="button" onClick={() => executeRustDebug()} disabled={executeBusy || actionsBlocked}>{executeBusy ? "Execute…" : "Rust Debug Execute"}</button>
      </div>
      {previewResult ? (
        <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
          <div className="row"><span>Mode</span><span>{String((previewResult.route as JsonMap | undefined)?.mode || "-")}</span></div>
          <div className="row"><span>Chosen</span><span>{String((((previewResult.route as JsonMap | undefined)?.chosen as JsonMap | undefined)?.venue) || "-")}</span></div>
          <div className="row"><span>Backup</span><span>{String((((previewResult.route as JsonMap | undefined)?.backup as JsonMap | undefined)?.venue) || "-")}</span></div>
          <div className="row"><span>Hedge</span><span>{String(((previewResult.hedge_guard as JsonMap | undefined)?.allow_execution) ? "allow" : "block")}</span></div>
          <div className="row"><span>Risk gate</span><span>{String(((previewResult.risk_gate as JsonMap | undefined)?.decision) || "-")}</span></div>
          <details style={{ marginTop: 10 }}>
            <summary className="subtle">Payload preview Rust</summary>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(previewResult, null, 2)}</pre>
          </details>
        </div>
      ) : null}
      {executeResult ? (
        <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
          <div className="row"><span>Status</span><span>{String(executeResult.status || "-")}</span></div>
          <div className="row"><span>Accepted</span><span>{String(Boolean(executeResult.accepted))}</span></div>
          <div className="row"><span>Chosen route</span><span>{String((((executeResult.route as JsonMap | undefined)?.chosen as JsonMap | undefined)?.venue) || "-")}</span></div>
          <div className="row"><span>Latency</span><span>{String(executeResult.processing_latency_ms || "-")}ms</span></div>
          <details style={{ marginTop: 10 }}>
            <summary className="subtle">Payload execute Rust</summary>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(executeResult, null, 2)}</pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}