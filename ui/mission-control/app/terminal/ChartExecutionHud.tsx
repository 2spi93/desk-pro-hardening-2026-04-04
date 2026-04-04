import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";

type ChartExecutionHudProps = {
  chartHudDragging: boolean;
  chartHudMinimized: boolean;
  chartHudPosition: { x: number; y: number };
  chartMotionClass: string;
  chartMotionPreset: string;
  chartOrderHudRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  compactMode: boolean;
  detached?: boolean;
  layoutScreenProfile: "sm" | "md" | "lg" | "xl";
  modeShortLabel: string;
  onBeginChartHudDrag: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onResetChartHud: () => void;
  onToggleChartHudMinimized: () => void;
  signalDisplayMode: string;
  signalFocusMode: boolean;
};

export default function ChartExecutionHud({
  chartHudDragging,
  chartHudMinimized,
  chartHudPosition,
  chartMotionClass,
  chartMotionPreset,
  chartOrderHudRef,
  children,
  compactMode,
  detached = false,
  layoutScreenProfile,
  modeShortLabel,
  onBeginChartHudDrag,
  onResetChartHud,
  onToggleChartHudMinimized,
  signalDisplayMode,
  signalFocusMode,
}: ChartExecutionHudProps) {
  const effectiveMinimized = chartHudMinimized || layoutScreenProfile === "sm" || compactMode;

  return (
    <div
      ref={chartOrderHudRef}
      className={`chart-order-hud signal-ui-${signalDisplayMode} ${signalFocusMode ? "signal-priority" : ""} ${compactMode ? "is-compact-mode" : ""} ${detached ? "is-detached" : ""} ${effectiveMinimized ? "is-collapsed" : ""} ${chartHudDragging ? "is-dragging" : ""}`}
      style={layoutScreenProfile === "sm" || detached ? undefined : { left: chartHudPosition.x, top: chartHudPosition.y }}
    >
      <div className="chart-order-hud-title" onMouseDown={onBeginChartHudDrag}>
        <span className="chart-order-hud-kicker">Execution Desk</span>
        <strong>Chart Trading</strong>
        <span className={`chart-order-hud-mode chart-order-hud-mode-${chartMotionClass}`}>{chartMotionPreset}</span>
        {!detached ? <button type="button" className="chart-order-hud-drag-handle" aria-label="Move Execution Desk">Drag</button> : null}
        <div className="chart-order-hud-title-actions">
          <button type="button" className="chart-order-hud-action" onClick={onToggleChartHudMinimized}>{effectiveMinimized ? "Expand" : "Reduce"}</button>
          {!detached ? <button type="button" className="chart-order-hud-action" onClick={onResetChartHud}>Reset</button> : null}
        </div>
      </div>
      {!effectiveMinimized ? (
        <div className="chart-order-hud-body">
          <div className="chart-mode-label">{modeShortLabel}</div>
          {children}
        </div>
      ) : null}
    </div>
  );
}