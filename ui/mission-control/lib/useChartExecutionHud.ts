import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type ChartHudBounds = { left: number; top: number; width: number; height: number };

type LayoutScreenProfile = "sm" | "md" | "lg" | "xl";

type UseChartExecutionHudOptions = {
  layoutScreenProfile: LayoutScreenProfile;
  signalDisplayMode: string;
};

export function useChartExecutionHud(
  { layoutScreenProfile, signalDisplayMode }: UseChartExecutionHudOptions,
) {
  const [chartHudMinimized, setChartHudMinimized] = useState(false);
  const [chartHudPosition, setChartHudPosition] = useState({ x: 10, y: 10 });
  const [chartHudDragging, setChartHudDragging] = useState(false);
  const [chartHudBounds, setChartHudBounds] = useState<ChartHudBounds | null>(null);
  const chartStageRef = useRef<HTMLDivElement | null>(null);
  const chartOrderHudRef = useRef<HTMLDivElement | null>(null);
  const chartHudDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);

  const beginChartHudDrag = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (layoutScreenProfile === "sm") {
      return;
    }
    const target = event.target as HTMLElement | null;
    const dragHandle = target?.closest(".chart-order-hud-drag-handle");
    if (!dragHandle) {
      return;
    }
    const stage = chartStageRef.current;
    const hud = chartOrderHudRef.current;
    if (!stage || !hud) {
      return;
    }
    const hudRect = hud.getBoundingClientRect();
    chartHudDragRef.current = {
      offsetX: event.clientX - hudRect.left,
      offsetY: event.clientY - hudRect.top,
    };
    setChartHudDragging(true);
    event.preventDefault();
  }, [layoutScreenProfile]);

  const resetChartHud = useCallback(() => {
    chartHudDragRef.current = null;
    setChartHudDragging(false);
    setChartHudMinimized(false);
    setChartHudPosition({ x: 10, y: 10 });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handlePointerMove = (event: MouseEvent) => {
      const dragState = chartHudDragRef.current;
      const stage = chartStageRef.current;
      const hud = chartOrderHudRef.current;
      if (!dragState || !stage || !hud || layoutScreenProfile === "sm") {
        return;
      }
      const stageRect = stage.getBoundingClientRect();
      const hudRect = hud.getBoundingClientRect();
      const nextX = event.clientX - stageRect.left - dragState.offsetX;
      const nextY = event.clientY - stageRect.top - dragState.offsetY;
      setChartHudPosition({
        x: Math.max(8, Math.min(stageRect.width - hudRect.width - 8, nextX)),
        y: Math.max(8, Math.min(stageRect.height - hudRect.height - 8, nextY)),
      });
    };

    const handlePointerUp = () => {
      chartHudDragRef.current = null;
      setChartHudDragging(false);
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [layoutScreenProfile]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const stage = chartStageRef.current;
    const hud = chartOrderHudRef.current;
    if (!stage || !hud || layoutScreenProfile === "sm") {
      setChartHudBounds(null);
      return undefined;
    }

    const syncHudBounds = () => {
      const stageRect = stage.getBoundingClientRect();
      const hudRect = hud.getBoundingClientRect();
      setChartHudBounds({
        left: Math.max(0, hudRect.left - stageRect.left),
        top: Math.max(0, hudRect.top - stageRect.top),
        width: hudRect.width,
        height: hudRect.height,
      });
    };

    syncHudBounds();

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => syncHudBounds())
      : null;
    resizeObserver?.observe(stage);
    resizeObserver?.observe(hud);
    window.addEventListener("resize", syncHudBounds);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncHudBounds);
    };
  }, [chartHudPosition, chartHudMinimized, chartHudDragging, layoutScreenProfile, signalDisplayMode]);

  return {
    chartHudBounds,
    chartHudDragging,
    chartHudMinimized,
    chartHudPosition,
    chartOrderHudRef,
    chartStageRef,
    beginChartHudDrag,
    resetChartHud,
    setChartHudMinimized,
  };
}