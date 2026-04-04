"use client";

import { useEffect, useState } from "react";

type JsonMap = Record<string, unknown>;

type RuntimeStatus = {
  active?: boolean;
  configured_enabled?: boolean;
  symbol?: string;
  venue?: string;
  cycle_seconds?: number;
  last_cycle_at?: string | null;
  last_error?: string | null;
  cycles_total?: number;
  proposed_total?: number;
  skipped_total?: number;
  persisted?: JsonMap;
};

type HarnessPreset = {
  label: string;
  description: string;
  payload: JsonMap;
};

const HARNESS_PRESETS: Record<string, HarnessPreset> = {
  solTrend: {
    label: "SOL Trend Harness",
    description: "Snapshot synthetique de tendance pour valider le gate momentum sans passer par l'API brute.",
    payload: {
      symbol: "SOLUSDT",
      venue: "paper-bingx",
      allow_live_handoff: false,
      isolate_runtime: true,
      seed_price_history: [141.8, 142.4, 143.1, 143.9, 144.8, 145.7, 146.9, 147.8, 148.9, 150.2, 151.1, 152.0],
      seed_volume_history: [820, 860, 910, 980, 1040, 1100, 1160, 1220, 1290, 1370, 1460, 1540],
      synthetic_snapshot: {
        depth: { best_bid: 151.92, best_ask: 152.08, spread_bps: 10.5 },
        micro: {
          mark_price: 152.0,
          buy_volume: 2400,
          sell_volume: 1600,
          spread_bps: 10.5,
          depth_top10: { bid: 1800, ask: 1200 },
          volume_imbalance: 0.32,
          depth_imbalance: 0.38,
        },
        session: { session: "us" },
      },
    },
  },
  solChop: {
    label: "SOL Chop Harness",
    description: "Snapshot synthetique de chop pour verifier que le regime momentum bloque bien l'execution SOL.",
    payload: {
      symbol: "SOLUSDT",
      venue: "paper-bingx",
      allow_live_handoff: false,
      isolate_runtime: true,
      seed_price_history: [152.1, 151.9, 152.0, 151.8, 152.05, 151.95, 152.02, 151.88, 152.0, 151.91, 151.99, 151.94],
      seed_volume_history: [910, 905, 915, 900, 920, 910, 900, 905, 915, 910, 900, 905],
      synthetic_snapshot: {
        depth: { best_bid: 151.9, best_ask: 152.1, spread_bps: 13.0 },
        micro: {
          mark_price: 152.0,
          buy_volume: 1700,
          sell_volume: 1725,
          spread_bps: 13.0,
          depth_top10: { bid: 1300, ask: 1325 },
          volume_imbalance: 0.01,
          depth_imbalance: -0.02,
        },
        session: { session: "us" },
      },
    },
  },
};

function asMap(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asList(value: unknown): JsonMap[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonMap => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "-";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function formatPercent(value: unknown, digits = 1): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(digits)}%` : "-";
}

function formatSignedPercent(value: unknown, digits = 1): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const signed = numeric >= 0 ? "+" : "";
  return `${signed}${(numeric * 100).toFixed(digits)}%`;
}

function formatRecommendation(value: unknown): string {
  const recommendation = asMap(value);
  const strategyMode = String(recommendation.strategy_mode || "none");
  const executionStyle = String(recommendation.execution_style || "default");
  const routeMode = String(recommendation.route_mode_override || "-");
  const sizeCap = toNumber(recommendation.size_multiplier_cap, 1);
  return `${strategyMode} · ${executionStyle} · ${routeMode} · size ${sizeCap.toFixed(2)}`;
}

function formatGateSummary(value: unknown): string {
  const gate = asMap(value);
  if (Object.keys(gate).length === 0) return "-";
  const status = String(gate.status || "unknown");
  const block = Boolean(gate.block_execution) ? "block" : "pass";
  const reasons = Array.isArray(gate.reasons) ? gate.reasons.map((item) => String(item)).join(", ") : "-";
  return `${status} · ${block} · ${reasons || "-"}`;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "-";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function KairosShadowClient() {
  const [status, setStatus] = useState<RuntimeStatus>({});
  const [cycles, setCycles] = useState<JsonMap[]>([]);
  const [decisions, setDecisions] = useState<JsonMap[]>([]);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [harnessBusy, setHarnessBusy] = useState<string | null>(null);
  const [harnessResult, setHarnessResult] = useState<JsonMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [statusResponse, cyclesResponse, decisionsResponse] = await Promise.all([
        fetch("/api/ai/kairos/shadow/status", { cache: "no-store" }),
        fetch("/api/ai/kairos/shadow/cycles?limit=20", { cache: "no-store" }),
        fetch("/api/ai/kairos/shadow/decisions?limit=20", { cache: "no-store" }),
      ]);

      const [statusBody, cyclesBody, decisionsBody] = await Promise.all([
        statusResponse.json().catch(() => ({})),
        cyclesResponse.json().catch(() => ({})),
        decisionsResponse.json().catch(() => ({})),
      ]);

      if (!statusResponse.ok) {
        throw new Error(String(asMap(statusBody).detail || "Unable to load Kairos status"));
      }

      setStatus(asMap(statusBody));
      setCycles(asList(asMap(cyclesBody).cycles));
      setDecisions(asList(asMap(decisionsBody).decisions));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function runAction(path: string): Promise<void> {
    setActing(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(asMap(body).detail || "Action failed"));
      }
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown error");
    } finally {
      setActing(false);
    }
  }

  async function runHarness(presetKey: string): Promise<void> {
    const preset = HARNESS_PRESETS[presetKey];
    if (!preset) return;
    setHarnessBusy(presetKey);
    try {
      const response = await fetch("/api/ai/kairos/shadow/harness/run-once", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preset.payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(asMap(body).detail || "Harness failed"));
      }
      setHarnessResult(asMap(body));
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown error");
    } finally {
      setHarnessBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const persisted = asMap(status.persisted);
  const selectedDecision = decisions.find((entry) => {
    const decision = asMap(entry.decision);
    return String(decision.decision_id || "") === selectedDecisionId;
  }) || null;
  const selectedDecisionPayload = asMap(selectedDecision);
  const selectedDecisionNode = asMap(selectedDecisionPayload.decision);
  const selectedPredictorNode = asMap(selectedDecisionPayload.predictor);
  const selectedMemoryNode = asMap(selectedDecisionPayload.memory);
  const selectedRecommendation = asMap(selectedMemoryNode.recommendation);
  const selectedPreTradeGate = asMap(selectedDecisionPayload.pre_trade_memory_gate || selectedMemoryNode.pre_trade_gate);
  const selectedProposedTrade = asMap(selectedDecisionPayload.proposed_trade);
  const harnessCycle = asMap(harnessResult?.cycle);
  const harnessDecision = asMap(harnessCycle.decision);
  const harnessMemory = asMap(harnessCycle.memory);
  const harnessGate = asMap(harnessCycle.pre_trade_memory_gate || harnessMemory.pre_trade_gate);
  const harnessExecution = asMap(harnessCycle.execution);

  return (
    <main className="page-shell" style={{ display: "grid", gap: 20 }}>
      <section className="panel" style={{ padding: 18, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <span className="eyebrow">Kairos Shadow Runtime</span>
            <h1 style={{ margin: 0 }}>Cycles shadow et recommandations mémoire</h1>
            <p className="subtle" style={{ margin: 0, maxWidth: 880 }}>
              Cette vue lit le journal SQL du premier loop Kairos shadow. Aucun ordre réel n’est envoyé ici: la page affiche les cycles,
              les décisions, le verdict predictor, et la recommandation Memory V2 appliquée ou non.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => void runAction("/api/ai/kairos/shadow/start")} disabled={acting}>
              Start loop
            </button>
            <button type="button" className="btn" onClick={() => void runAction("/api/ai/kairos/shadow/stop")} disabled={acting}>
              Stop loop
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void runAction("/api/ai/kairos/shadow/run-once")} disabled={acting}>
              Run once
            </button>
          </div>
        </div>

        {error ? <div className="panel bad" style={{ padding: 12 }}>{error}</div> : null}

        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Runtime</div>
            <strong>{status.active ? "Active" : "Idle"}</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Symbol</div>
            <strong>{String(status.symbol || "-")}</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Venue</div>
            <strong>{String(status.venue || "-")}</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Cycle</div>
            <strong>{toNumber(status.cycle_seconds, 0).toFixed(0)}s</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Persisted Cycles</div>
            <strong>{toNumber(persisted.cycle_count, 0)}</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Persisted Decisions</div>
            <strong>{toNumber(persisted.decision_count, 0)}</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Proposed</div>
            <strong>{toNumber(status.proposed_total, 0)}</strong>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Skipped</div>
            <strong>{toNumber(status.skipped_total, 0)}</strong>
          </div>
        </div>

        <div className="panel" style={{ padding: 12 }}>
          <div className="eyebrow">Last Cycle</div>
          <strong>{formatDateTime(status.last_cycle_at)}</strong>
          <div className="subtle" style={{ marginTop: 6 }}>
            Last persisted cycle: {formatDateTime(persisted.last_cycle_at)}
          </div>
          {status.last_error ? <div className="bad" style={{ marginTop: 8 }}>{String(status.last_error)}</div> : null}
        </div>

        <div className="panel" style={{ padding: 12, display: "grid", gap: 10 }}>
          <div>
            <div className="eyebrow">Harness SOL</div>
            <strong>Validation synthetic-one-shot</strong>
            <div className="subtle" style={{ marginTop: 6 }}>Deux presets pour lancer SOL trend/chop directement depuis Mission Control et distinguer les validations du flux live.</div>
          </div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            {Object.entries(HARNESS_PRESETS).map(([presetKey, preset]) => (
              <div key={presetKey} className="panel" style={{ padding: 12, display: "grid", gap: 8 }}>
                <div>
                  <div className="eyebrow">{preset.label}</div>
                  <div className="subtle" style={{ marginTop: 6 }}>{preset.description}</div>
                </div>
                <button type="button" className="btn btn-primary" onClick={() => void runHarness(presetKey)} disabled={Boolean(harnessBusy)}>
                  {harnessBusy === presetKey ? "Running..." : "Run harness"}
                </button>
              </div>
            ))}
          </div>
          {harnessResult ? (
            <div className="panel" style={{ padding: 12, display: "grid", gap: 10 }}>
              <div className="eyebrow">Last Harness Result</div>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
                <div>
                  <div className="subtle">Mode</div>
                  <strong>{String(asMap(harnessCycle.harness).mode || "-")}</strong>
                </div>
                <div>
                  <div className="subtle">Action</div>
                  <strong>{String(harnessCycle.shadow_action || "-")}</strong>
                </div>
                <div>
                  <div className="subtle">Decision</div>
                  <strong>{String(harnessDecision.direction || "-")}</strong>
                </div>
                <div>
                  <div className="subtle">Memory Gate</div>
                  <strong>{String(harnessGate.status || "-")}</strong>
                </div>
                <div>
                  <div className="subtle">Execution</div>
                  <strong>{String(harnessExecution.status || "-")}</strong>
                </div>
              </div>
              <div className="subtle">Reasons: {Array.isArray(harnessCycle.shadow_reasons) ? harnessCycle.shadow_reasons.map((item) => String(item)).join(", ") || "-" : "-"}</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(harnessResult)}</pre>
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel" style={{ padding: 18, display: "grid", gap: 12 }}>
        <div>
          <span className="eyebrow">Cycles</span>
          <h2 style={{ margin: "6px 0 0" }}>Journal SQL des cycles shadow</h2>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
            <thead>
              <tr>
                <th align="left">Cycle</th>
                <th align="left">Action</th>
                <th align="left">Decision</th>
                <th align="left">Predictor</th>
                <th align="left">Memory</th>
                <th align="left">Recommendation</th>
                <th align="left">Reasons</th>
              </tr>
            </thead>
            <tbody>
              {(loading ? [] : cycles).map((cycle) => {
                const decision = asMap(cycle.decision);
                const predictor = asMap(cycle.predictor);
                const memory = asMap(cycle.memory);
                const reasons = Array.isArray(cycle.shadow_reasons) ? cycle.shadow_reasons.map((item) => String(item)).join(", ") : "-";
                return (
                  <tr key={String(cycle.cycle_id || Math.random())} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: "10px 8px" }}>
                      <div>{formatDateTime(cycle.cycle_at)}</div>
                      <div className="subtle">{String(cycle.symbol || "-")} · {String(cycle.venue || "-")}</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}><strong>{String(cycle.shadow_action || "-")}</strong></td>
                    <td style={{ padding: "10px 8px" }}>
                      <div>{String(decision.direction || "-")}</div>
                      <div className="subtle">conf {formatPercent(decision.meta_confidence)} · consensus {toNumber(decision.agent_consensus_pct, 0).toFixed(1)}%</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <div>{Boolean(predictor.should_execute) ? "execute" : "skip"}</div>
                      <div className="subtle">fill {formatPercent(predictor.fill_probability)} · slippage {toNumber(predictor.slippage_bps, 0).toFixed(2)}bps</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <div>{String(memory.source || "none")}</div>
                      <div className="subtle">conf {formatPercent(memory.confidence)}</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}>{formatRecommendation(memory.recommendation)}</td>
                    <td style={{ padding: "10px 8px" }} className="subtle">{reasons || "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" style={{ padding: 18, display: "grid", gap: 12 }}>
        <div>
          <span className="eyebrow">Decisions</span>
          <h2 style={{ margin: "6px 0 0" }}>Journal SQL des décisions Kairos</h2>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
            <thead>
              <tr>
                <th align="left">Decision</th>
                <th align="left">Direction</th>
                <th align="left">Confidence</th>
                <th align="left">Risk</th>
                <th align="left">Predictor</th>
                <th align="left">Memory</th>
                <th align="left">Proposed Trade</th>
                <th align="left">Inspect</th>
              </tr>
            </thead>
            <tbody>
              {(loading ? [] : decisions).map((entry) => {
                const decision = asMap(entry.decision);
                const predictor = asMap(entry.predictor);
                const memory = asMap(entry.memory);
                const gate = asMap(entry.pre_trade_memory_gate || memory.pre_trade_gate);
                const proposedTrade = asMap(entry.proposed_trade);
                const decisionId = String(decision.decision_id || "");
                return (
                  <tr key={decisionId || String(Math.random())} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: "10px 8px" }}>
                      <div>{formatDateTime(decision.timestamp)}</div>
                      <div className="subtle">{String(entry.symbol || "-")} · {String(entry.venue || "-")}</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}><strong>{String(decision.direction || "-")}</strong></td>
                    <td style={{ padding: "10px 8px" }}>{formatPercent(decision.meta_confidence)} · {toNumber(decision.agent_consensus_pct, 0).toFixed(1)}%</td>
                    <td style={{ padding: "10px 8px" }}>{Boolean(decision.risk_approved) ? "approved" : `blocked: ${String(decision.risk_reason || "-")}`}</td>
                    <td style={{ padding: "10px 8px" }}>{Boolean(predictor.should_execute) ? "execute" : "skip"}</td>
                    <td style={{ padding: "10px 8px" }}>
                      <div>{String(memory.source || "none")}</div>
                      <div className="subtle">{formatRecommendation(memory.recommendation)}</div>
                      <div className="subtle">gate {formatGateSummary(gate)}</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      {Object.keys(proposedTrade).length ? `${String(proposedTrade.side || "-")} · ${formatSignedPercent(toNumber(proposedTrade.position_size_pct, 0) / 100, 2)}` : "-"}
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setSelectedDecisionId((current) => (current === decisionId ? null : decisionId))}
                      >
                        {selectedDecisionId === decisionId ? "Hide" : "Inspect"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selectedDecision ? (
          <div className="panel" style={{ padding: 16, display: "grid", gap: 14 }}>
            <div>
              <span className="eyebrow">Decision Drill-down</span>
              <h3 style={{ margin: "6px 0 0" }}>Inspection opérateur fine</h3>
            </div>

            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Decision</div>
                <strong>{String(selectedDecisionNode.direction || "-")}</strong>
                <div className="subtle">{formatDateTime(selectedDecisionNode.timestamp)}</div>
              </div>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Confidence</div>
                <strong>{formatPercent(selectedDecisionNode.meta_confidence)}</strong>
                <div className="subtle">Consensus {toNumber(selectedDecisionNode.agent_consensus_pct, 0).toFixed(1)}%</div>
              </div>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Predictor</div>
                <strong>{Boolean(selectedPredictorNode.should_execute) ? "execute" : "skip"}</strong>
                <div className="subtle">Fill {formatPercent(selectedPredictorNode.fill_probability)}</div>
              </div>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Memory</div>
                <strong>{String(selectedMemoryNode.source || "none")}</strong>
                <div className="subtle">Conf {formatPercent(selectedMemoryNode.confidence)}</div>
              </div>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Pre-trade Gate</div>
                <strong>{String(selectedPreTradeGate.status || "-")}</strong>
                <div className="subtle">{Boolean(selectedPreTradeGate.block_execution) ? "blocked" : "pass"}</div>
              </div>
            </div>

            <div className="panel" style={{ padding: 12 }}>
              <div className="eyebrow">Recommendation</div>
              <div style={{ marginTop: 6 }}><strong>{formatRecommendation(selectedRecommendation)}</strong></div>
              <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(selectedRecommendation)}</pre>
            </div>

            <div className="panel" style={{ padding: 12 }}>
              <div className="eyebrow">Pre-trade Memory Gate</div>
              <div style={{ marginTop: 6 }}><strong>{formatGateSummary(selectedPreTradeGate)}</strong></div>
              <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(selectedPreTradeGate)}</pre>
            </div>

            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Raw Memory Query Payload</div>
                <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(selectedMemoryNode.query_payload)}</pre>
              </div>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Raw Memory Response</div>
                <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(selectedMemoryNode.raw_response)}</pre>
              </div>
            </div>

            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Decision Payload</div>
                <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(selectedDecisionNode)}</pre>
              </div>
              <div className="panel" style={{ padding: 12 }}>
                <div className="eyebrow">Proposed Trade</div>
                <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>{formatJson(selectedProposedTrade)}</pre>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
