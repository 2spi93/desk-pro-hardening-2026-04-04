import type { ReactNode } from "react";

import type { ChartSidecarDepthBias, ChartSidecarLayoutMode, ChartSidecarProfile } from "./chartSidecarTypes";
type ChartSidecarRowSide = "bid" | "ask" | "buy" | "sell" | "flat";

type PolicyOption = {
  id: ChartSidecarProfile;
  label: string;
  active: boolean;
  onSelect: () => void;
};

type PolicyPill = {
  text: string;
  className?: string;
};

type DomLevelRow = {
  key: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
  highlighted: boolean;
};

type TapeRow = {
  key: string;
  side: ChartSidecarRowSide;
  label: string;
  price: number;
  volume: number;
  highlighted: boolean;
};

type FootprintRow = {
  key: string;
  timeLabel: string;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  highlighted: boolean;
};

type HeatRow = {
  key: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
  highlighted: boolean;
};

type SuggestedBracket = {
  label: string;
  side: "buy" | "sell";
  rr: number;
  entry: number;
  sl: number;
  tp: number;
};

type SuggestedLiquidityHighlight = {
  level: number;
  exactTpMatch: boolean;
} | null;

type HeadProps = {
  title: string;
  value: ReactNode;
  headActions?: ReactNode;
};

function SidecarHead({ title, value, headActions }: HeadProps) {
  return (
    <div className="chart-sidecar-head">
      <div>
        <span className="chart-sidecar-kicker">{title}</span>
        <strong>{value}</strong>
      </div>
      {headActions}
    </div>
  );
}

type ActionPillProps = {
  children: ReactNode;
  status?: "good" | "warn" | "bad";
};

function ChartActionPill({ children, status }: ActionPillProps) {
  const className = status ? `chart-action-pill chart-action-pill-status ${status}` : "chart-action-pill";
  return <span className={className}>{children}</span>;
}

type PolicySidecarCardProps = {
  headActions?: ReactNode;
  profileLabel: string;
  profileOptions: PolicyOption[];
  layoutMode: ChartSidecarLayoutMode;
  onApplyLayout: (mode: Exclude<ChartSidecarLayoutMode, "custom">) => void;
  onSaveCustom: () => void;
  pills: PolicyPill[];
};

export function PolicySidecarCard({
  headActions,
  profileLabel,
  profileOptions,
  layoutMode,
  onApplyLayout,
  onSaveCustom,
  pills,
}: PolicySidecarCardProps) {
  return (
    <section className="chart-sidecar-card chart-sidecar-card-control">
      <SidecarHead title="Desk Layout" value={profileLabel} headActions={headActions} />
      <div className="chart-sidecar-profile-row" role="group" aria-label="Chart sidecar profile">
        {profileOptions.map((profile) => (
          <button
            key={`chart-sidecar-profile-${profile.id}`}
            type="button"
            className={`chart-chip ${profile.active ? "active" : ""}`}
            onClick={profile.onSelect}
          >
            {profile.label}
          </button>
        ))}
      </div>
      <div className="chart-sidecar-layout-row" role="group" aria-label="Chart sidecar layout mode">
        <button type="button" className={`chart-chip ${layoutMode === "docked" ? "active" : ""}`} onClick={() => onApplyLayout("docked")}>Docked</button>
        <button type="button" className={`chart-chip ${layoutMode === "hybrid" ? "active" : ""}`} onClick={() => onApplyLayout("hybrid")}>Hybrid</button>
        <button type="button" className={`chart-chip ${layoutMode === "detached" ? "active" : ""}`} onClick={() => onApplyLayout("detached")}>Detached</button>
        <button type="button" className={`chart-chip ${layoutMode === "custom" ? "active" : ""}`} onClick={onSaveCustom}>Custom save</button>
      </div>
      <div className="chart-sidecar-grid">
        {pills.map((pill) => (
          <span key={pill.text} className={pill.className ? `chart-action-pill ${pill.className}` : "chart-action-pill"}>{pill.text}</span>
        ))}
      </div>
    </section>
  );
}

type DomTapeSidecarCardProps = {
  headActions?: ReactNode;
  depthBias: ChartSidecarDepthBias;
  bidDepth: number;
  askDepth: number;
  tapeDelta: number;
  domRows: DomLevelRow[];
  tapeRows: TapeRow[];
};

export function DomTapeSidecarCard({ headActions, depthBias, bidDepth, askDepth, tapeDelta, domRows, tapeRows }: DomTapeSidecarCardProps) {
  return (
    <section className="chart-sidecar-card">
      <SidecarHead
        title="DOM / Tape"
        value={<span className={`chart-sidecar-bias chart-sidecar-bias-${depthBias}`}>{depthBias}</span>}
        headActions={headActions}
      />
      <div className="chart-sidecar-grid">
        <ChartActionPill>bid {bidDepth.toFixed(0)}</ChartActionPill>
        <ChartActionPill>ask {askDepth.toFixed(0)}</ChartActionPill>
        <ChartActionPill status={tapeDelta >= 0 ? "good" : "bad"}>tape Δ {tapeDelta >= 0 ? "+" : ""}{tapeDelta.toFixed(0)}</ChartActionPill>
      </div>
      <div className="chart-sidecar-scroll">
        {domRows.map((level) => (
          <div key={level.key} className={`chart-sidecar-row ${level.side} ${level.highlighted ? "is-highlighted" : ""}`}>
            <span>{level.side === "ask" ? "A" : "B"}</span>
            <span>{level.price.toFixed(1)}</span>
            <span>{level.size}</span>
            <span>{Math.round(level.intensity * 100)}%</span>
          </div>
        ))}
        {tapeRows.map((print) => (
          <div key={print.key} className={`chart-sidecar-row tape ${print.side} ${print.highlighted ? "is-highlighted" : ""}`}>
            <span>{print.label.slice(-8)}</span>
            <span>{print.price.toFixed(1)}</span>
            <span>{print.volume}</span>
            <span>{print.side === "buy" ? "B" : print.side === "sell" ? "S" : "-"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

type FootprintHeatSidecarCardProps = {
  headActions?: ReactNode;
  footprintDelta: number;
  strictDepthTimeMatch: boolean;
  footprintRows: FootprintRow[];
  heatRows: HeatRow[];
};

export function FootprintHeatSidecarCard({ headActions, footprintDelta, strictDepthTimeMatch, footprintRows, heatRows }: FootprintHeatSidecarCardProps) {
  return (
    <section className="chart-sidecar-card">
      <SidecarHead
        title="Footprint / Heat"
        value={<span className={footprintDelta >= 0 ? "good" : "warn"}>{footprintDelta >= 0 ? "+" : ""}{footprintDelta.toFixed(0)}</span>}
        headActions={headActions}
      />
      <div className="chart-sidecar-grid">
        <ChartActionPill status={strictDepthTimeMatch ? "good" : "warn"}>sync {strictDepthTimeMatch ? "locked" : "lag"}</ChartActionPill>
        <ChartActionPill>heat {heatRows.length}</ChartActionPill>
        <ChartActionPill>fp {footprintRows.length}</ChartActionPill>
      </div>
      <div className="chart-sidecar-scroll">
        {footprintRows.map((row) => (
          <div key={row.key} className={`chart-sidecar-row footprint ${row.highlighted ? "is-highlighted" : ""}`}>
            <span>{row.timeLabel ? row.timeLabel.slice(-5) : "--:--"}</span>
            <span>{row.buyVolume.toFixed(0)}</span>
            <span>{row.sellVolume.toFixed(0)}</span>
            <span className={row.delta >= 0 ? "good" : "warn"}>{row.delta >= 0 ? "+" : ""}{row.delta.toFixed(0)}</span>
          </div>
        ))}
        {heatRows.map((level) => (
          <div key={level.key} className={`chart-sidecar-row heat ${level.side} ${level.highlighted ? "is-highlighted" : ""}`}>
            <span>{level.side === "ask" ? "ASK" : "BID"}</span>
            <span>{level.price.toFixed(1)}</span>
            <span>{level.size}</span>
            <span>{Math.round(level.intensity * 100)}%</span>
          </div>
        ))}
      </div>
    </section>
  );
}

type ExecutionSidecarCardProps = {
  headActions?: ReactNode;
  sideLabel: string;
  entry: number;
  sl: number;
  tp: number;
  chartPriceDigits: number;
  chartRiskReward: number;
  chartRiskUsd: number;
  chartMaxLossUsd: number;
  chartRewardUsd: number;
  chartTargetGainUsd: number;
  suggestedBracket: SuggestedBracket | null;
  suggestedLiquidityHighlight: SuggestedLiquidityHighlight;
  onApplyBracket: () => void;
  onApproveAll: () => void;
  onApproveAllAndSend: () => void;
  approveAllAndSendLabel: string;
  approveAllAndSendDisabled?: boolean;
  showCriticalActions: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  selectedChartSymbol: string;
  ocoEnabled: boolean;
  chartSnapEnabled: boolean;
  chartSnapPriorityLabel: string;
};

export function ExecutionSidecarCard({
  headActions,
  sideLabel,
  entry,
  sl,
  tp,
  chartPriceDigits,
  chartRiskReward,
  chartRiskUsd,
  chartMaxLossUsd,
  chartRewardUsd,
  chartTargetGainUsd,
  suggestedBracket,
  suggestedLiquidityHighlight,
  onApplyBracket,
  onApproveAll,
  onApproveAllAndSend,
  approveAllAndSendLabel,
  approveAllAndSendDisabled = false,
  showCriticalActions,
  previewOpen,
  onTogglePreview,
  selectedChartSymbol,
  ocoEnabled,
  chartSnapEnabled,
  chartSnapPriorityLabel,
}: ExecutionSidecarCardProps) {
  return (
    <section className="chart-sidecar-card chart-sidecar-card-execution">
      <SidecarHead title="Execution Sidecar" value={sideLabel} headActions={headActions} />
      <div className="chart-sidecar-grid">
        <ChartActionPill>entry {entry.toFixed(chartPriceDigits)}</ChartActionPill>
        <ChartActionPill>sl {sl.toFixed(chartPriceDigits)}</ChartActionPill>
        <ChartActionPill>tp {tp.toFixed(chartPriceDigits)}</ChartActionPill>
        <ChartActionPill>RR {chartRiskReward.toFixed(2)}</ChartActionPill>
        <ChartActionPill status={chartRiskUsd <= chartMaxLossUsd ? "good" : "bad"}>risk {chartRiskUsd.toFixed(0)} USD</ChartActionPill>
        <ChartActionPill status={chartRewardUsd >= chartTargetGainUsd ? "good" : "warn"}>reward {chartRewardUsd.toFixed(0)} USD</ChartActionPill>
      </div>
      {suggestedBracket ? (
        <div className="chart-sidecar-execution-stack">
          <div className="chart-sidecar-execution-title">Suggested Bracket</div>
          <div className="chart-sidecar-grid">
            <ChartActionPill>{suggestedBracket.label}</ChartActionPill>
            <ChartActionPill>{suggestedBracket.side.toUpperCase()} · RR {suggestedBracket.rr.toFixed(2)}</ChartActionPill>
            <ChartActionPill>E {suggestedBracket.entry.toFixed(chartPriceDigits)}</ChartActionPill>
            <ChartActionPill>SL {suggestedBracket.sl.toFixed(chartPriceDigits)}</ChartActionPill>
            <ChartActionPill>TP {suggestedBracket.tp.toFixed(chartPriceDigits)}</ChartActionPill>
            {suggestedLiquidityHighlight ? (
              <ChartActionPill status={suggestedLiquidityHighlight.exactTpMatch ? "good" : "warn"}>
                {suggestedLiquidityHighlight.exactTpMatch ? "TP=LIQ" : "LIQ"} {suggestedLiquidityHighlight.level.toFixed(chartPriceDigits)}
              </ChartActionPill>
            ) : null}
          </div>
          <div className="chart-sidecar-profile-row">
            <button type="button" className="chart-chip" onClick={onApplyBracket}>Apply Bracket</button>
            {showCriticalActions ? (
              <>
                <button type="button" className="chart-chip active" onClick={onApproveAll}>Approve All</button>
                <button type="button" className="chart-chip chart-buy-btn" disabled={approveAllAndSendDisabled} onClick={onApproveAllAndSend}>{approveAllAndSendLabel}</button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="chart-sidecar-execution-stack">
        <div className="chart-sidecar-head">
          <div>
            <span className="chart-sidecar-kicker">Order Preview</span>
            <strong>{previewOpen ? "Expanded" : "Compact"}</strong>
          </div>
          <div className="chart-sidecar-actions">
            <button type="button" className={`chart-sidecar-head-btn ${previewOpen ? "active" : ""}`} onClick={onTogglePreview}>
              {previewOpen ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <div className="chart-sidecar-preview-grid">
          <span>Side</span><strong>{sideLabel}</strong>
          <span>Symbol</span><strong>{selectedChartSymbol}</strong>
          <span>OCO</span><strong>{ocoEnabled ? "ON" : "OFF"}</strong>
          <span>Snap</span><strong>{chartSnapEnabled ? chartSnapPriorityLabel : "FREE"}</strong>
        </div>
        {previewOpen ? (
          <div className="chart-sidecar-preview-grid">
            <span>Entry</span><strong>{entry.toFixed(4)}</strong>
            <span>Stop Loss</span><strong>{sl.toFixed(4)}</strong>
            <span>Take Profit</span><strong>{tp.toFixed(4)}</strong>
            <span>Perte max</span><strong className="warn">{chartRiskUsd.toFixed(2)} USD</strong>
            <span>Gain cible</span><strong className="good">{chartRewardUsd.toFixed(2)} USD</strong>
            <span>R/R</span><strong>{chartRiskReward.toFixed(2)}</strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}

type LocalFeedSidecarCardProps = {
  headActions?: ReactNode;
  message: string;
  captureClientId: string | null;
  captureUpdatedAt: string | null;
  captureHealthy: boolean;
  captureDetail: string;
  captureHistoryCount: number;
  autoIncidentTicketKey: string | null;
  autoIncidentStatus: string | null;
  feedLabel: string;
  signal: "OHLCV_RENDERABLE" | "OHLCV_PARTIAL" | "OHLCV_UNUSABLE";
  fetchedRows: number;
  renderableRows: number;
  droppedRows: number;
  duplicateTimestamps: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  reasons: string[];
  droppedReasonKinds: string[];
  fallbackSuggestion: {
    symbol: string;
    instrument: string;
    venue: string;
    timeframe: string;
    autoFallback: boolean;
  } | null;
  onApplyFallback: () => void;
  onDismissFallback: () => void;
};

export function LocalFeedSidecarCard({
  headActions,
  message,
  captureClientId,
  captureUpdatedAt,
  captureHealthy,
  captureDetail,
  captureHistoryCount,
  autoIncidentTicketKey,
  autoIncidentStatus,
  feedLabel,
  signal,
  fetchedRows,
  renderableRows,
  droppedRows,
  duplicateTimestamps,
  firstTimestamp,
  lastTimestamp,
  reasons,
  droppedReasonKinds,
  fallbackSuggestion,
  onApplyFallback,
  onDismissFallback,
}: LocalFeedSidecarCardProps) {
  const status = signal === "OHLCV_RENDERABLE" ? "good" : signal === "OHLCV_PARTIAL" ? "warn" : "bad";
  const reasonLabel = reasons.length > 0 ? reasons.join(" · ") : "none";
  const droppedKindsLabel = droppedReasonKinds.length > 0 ? droppedReasonKinds.join(" · ") : "none";

  return (
    <section className="chart-sidecar-card">
      <SidecarHead title="Local Feed" value={<span className={status === "good" ? "good" : "warn"}>{signal.replace("OHLCV_", "")}</span>} headActions={headActions} />
      <div className="chart-sidecar-execution-stack">
        <div className="chart-sidecar-kicker">Local diagnosis</div>
        <strong>{message}</strong>
        <div className="chart-sidecar-preview-grid">
          <span>Capture</span><strong>{captureClientId || "-"}</strong>
          <span>Persisted</span><strong>{captureUpdatedAt ? captureUpdatedAt.slice(11, 19) : "-"}</strong>
          <span>Feed</span><strong>{feedLabel}</strong>
          <span>Rows</span><strong>{renderableRows}/{fetchedRows}</strong>
          <span>Dropped</span><strong>{droppedRows}</strong>
          <span>Duplicates</span><strong>{duplicateTimestamps}</strong>
          <span>Sync</span><strong>{captureDetail}</strong>
        </div>
      </div>
      <div className="chart-sidecar-grid">
        <ChartActionPill status={status}>signal {signal.replace("OHLCV_", "").toLowerCase()}</ChartActionPill>
        <ChartActionPill status={renderableRows > 0 ? "good" : "bad"}>renderable {renderableRows}</ChartActionPill>
        <ChartActionPill status={droppedRows === 0 ? "good" : "warn"}>dropped {droppedRows}</ChartActionPill>
        <ChartActionPill status={captureHealthy ? "good" : "warn"}>persist {captureHealthy ? "ok" : captureDetail}</ChartActionPill>
        <ChartActionPill>history {captureHistoryCount}</ChartActionPill>
        <ChartActionPill status={autoIncidentStatus === "opened" ? "bad" : autoIncidentStatus === "failed" ? "warn" : "good"}>incident {autoIncidentTicketKey || autoIncidentStatus || "none"}</ChartActionPill>
        <ChartActionPill>first {firstTimestamp ? firstTimestamp.slice(11, 19) : "-"}</ChartActionPill>
        <ChartActionPill>last {lastTimestamp ? lastTimestamp.slice(11, 19) : "-"}</ChartActionPill>
      </div>
      <div className="chart-sidecar-execution-stack">
        <div className="chart-sidecar-kicker">Reasons</div>
        <div className="chart-sidecar-grid">
          <ChartActionPill>{reasonLabel}</ChartActionPill>
          <ChartActionPill>{droppedKindsLabel}</ChartActionPill>
        </div>
      </div>
      {fallbackSuggestion ? (
        <div className="chart-sidecar-execution-stack">
          <div className="chart-sidecar-kicker">Fallback proposal</div>
          <div className="chart-sidecar-preview-grid">
            <span>Symbol</span><strong>{fallbackSuggestion.symbol}</strong>
            <span>Feed</span><strong>{fallbackSuggestion.instrument} @ {fallbackSuggestion.venue}</strong>
            <span>Timeframe</span><strong>{fallbackSuggestion.timeframe}</strong>
            <span>Auto</span><strong>{fallbackSuggestion.autoFallback ? "armed" : "manual"}</strong>
          </div>
          <div className="chart-sidecar-profile-row">
            <button type="button" className="chart-chip chart-buy-btn" onClick={onApplyFallback}>Switch to healthy feed</button>
            <button type="button" className="chart-chip" onClick={onDismissFallback}>Keep current</button>
          </div>
        </div>
      ) : null}
      <div className="chart-sidecar-profile-row">
        {autoIncidentTicketKey ? <a className="chart-chip" href={`/incidents#${autoIncidentTicketKey}`}>Open ticket</a> : null}
        {captureClientId ? <a className="chart-chip" href={`/api/health/local-terminal?client_id=${encodeURIComponent(captureClientId)}`} target="_blank" rel="noreferrer">Open capture JSON</a> : null}
      </div>
    </section>
  );
}

type ForensicReplaySidecarCardProps = {
  headActions?: ReactNode;
  captureClientId: string | null;
  attributionHeadline: string;
  attributionContextLabel: string;
  attributionPills: string[];
  agentLearningHeadline: string;
  agentLearningPills: string[];
  latentHeadline: string;
  provenanceHeadline: string;
  latentPills: string[];
  frames: Array<{
    capturedAt: string;
    feedLabel: string;
    signal: string;
    blockedByFiveStateFailure: boolean;
    noCandlesExpected: boolean;
    exactStateVector: string[];
    replayLatentLabel: string;
    replayOriginLabel: string;
  }>;
  autoIncidentTicketKey: string | null;
  autoIncidentStatus: string | null;
};

export function ForensicReplaySidecarCard({
  headActions,
  captureClientId,
  attributionHeadline,
  attributionContextLabel,
  attributionPills,
  agentLearningHeadline,
  agentLearningPills,
  latentHeadline,
  provenanceHeadline,
  latentPills,
  frames,
  autoIncidentTicketKey,
  autoIncidentStatus,
}: ForensicReplaySidecarCardProps) {
  return (
    <section className="chart-sidecar-card">
      <SidecarHead title="Forensic Replay" value={<span>{frames.length} frames</span>} headActions={headActions} />
      <div className="chart-sidecar-grid">
        <ChartActionPill>{captureClientId || "no-client"}</ChartActionPill>
        <ChartActionPill status={autoIncidentStatus === "opened" ? "bad" : autoIncidentStatus === "closed" ? "good" : "warn"}>incident {autoIncidentTicketKey || autoIncidentStatus || "none"}</ChartActionPill>
      </div>
      <div className="chart-sidecar-execution-stack">
        <div className="chart-sidecar-kicker">Attribution Replay</div>
        <div className="chart-sidecar-preview-grid">
          <span>Leader</span><strong>{attributionHeadline}</strong>
          <span>Context</span><strong>{attributionContextLabel}</strong>
        </div>
        <div className="chart-sidecar-grid">
          {attributionPills.length > 0 ? attributionPills.map((pill) => (
            <ChartActionPill key={`forensic-attribution-${pill}`}>{pill}</ChartActionPill>
          )) : <ChartActionPill>Attribution warming up</ChartActionPill>}
        </div>
      </div>
      <div className="chart-sidecar-execution-stack">
        <div className="chart-sidecar-kicker">Latent / Dream</div>
        <div className="chart-sidecar-preview-grid">
          <span>Transition</span><strong>{latentHeadline}</strong>
          <span>Provenance</span><strong>{provenanceHeadline}</strong>
        </div>
        <div className="chart-sidecar-grid">
          {latentPills.length > 0 ? latentPills.map((pill) => (
            <ChartActionPill key={`forensic-latent-${pill}`}>{pill}</ChartActionPill>
          )) : <ChartActionPill>Latent state warming up</ChartActionPill>}
        </div>
      </div>
      <div className="chart-sidecar-execution-stack">
        <div className="chart-sidecar-kicker">Agent LR</div>
        <div className="chart-sidecar-preview-grid">
          <span>Spread</span><strong>{agentLearningHeadline}</strong>
          <span>Why</span><strong>{agentLearningPills[0] || "No agent LR trace yet"}</strong>
        </div>
        <div className="chart-sidecar-grid">
          {agentLearningPills.length > 0 ? agentLearningPills.map((pill) => (
            <ChartActionPill key={`forensic-agent-lr-${pill}`}>{pill}</ChartActionPill>
          )) : <ChartActionPill>Agent LR warming up</ChartActionPill>}
        </div>
      </div>
      <div className="chart-sidecar-scroll">
        {frames.length === 0 ? <div className="chart-sidecar-row flat"><span>No forensic frames yet</span></div> : null}
        {frames.map((frame) => (
          <div key={`${frame.capturedAt}-${frame.signal}`} className={`chart-sidecar-row ${frame.blockedByFiveStateFailure ? "sell" : frame.noCandlesExpected ? "flat" : "buy"}`}>
            <span>{frame.capturedAt.slice(11, 19)}</span>
            <span>{frame.signal.replace("OHLCV_", "")}</span>
            <span>{frame.blockedByFiveStateFailure ? "5X FAIL" : frame.noCandlesExpected ? "NO CANDLES" : "FLOWING"}</span>
            <span>{[...frame.exactStateVector, frame.replayLatentLabel, frame.replayOriginLabel].filter(Boolean).join(" · ")}</span>
          </div>
        ))}
      </div>
      <div className="chart-sidecar-profile-row">
        {captureClientId ? <a className="chart-chip" href={`/api/health/local-terminal?client_id=${encodeURIComponent(captureClientId)}`} target="_blank" rel="noreferrer">Query this client</a> : null}
        {autoIncidentTicketKey ? <a className="chart-chip" href={`/incidents#${autoIncidentTicketKey}`}>Open incident desk</a> : null}
      </div>
    </section>
  );
}
