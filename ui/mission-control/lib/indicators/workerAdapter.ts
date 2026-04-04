/**
 * Web Worker adapter — foundation for compute offloading.
 *
 * DESIGN (NOT YET ACTIVE):
 *
 * Indicator computation is CPU-intensive. For heavy workloads:
 *   - Heavy indicators (Footprint, Delta, Volume Profile)
 *   - Multiple charts (3-4 instances)
 *   - High-frequency data (200+ bars updating)
 *
 * This adapter offloads compute to a Web Worker thread.
 *
 * PHASE 2 IMPLEMENTATION:
 *   - Create /public/workers/indicatorWorker.ts
 *   - Send bars + params → worker
 *   - Receive serialized result
 *   - Main thread never blocks
 *
 * For now: shim that uses main thread (sync compute)
 * Later: async compute in worker
 */

import type { ActiveIndicator, BarData, IndicatorSeriesData } from "./engine";
import { computeAllIndicators } from "./engine";

type WorkerMessage =
  | { type: "compute"; bars: BarData[]; active: ActiveIndicator[]; id: string }
  | { type: "cancel"; id: string };

type WorkerResult = {
  id: string;
  result: IndicatorSeriesData[];
  error?: string;
};

function canUseWorker(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

type PendingRequest = {
  resolve: (result: IndicatorSeriesData[]) => void;
  bars: BarData[];
  active: ActiveIndicator[];
};

export class IndicatorWorkerAdapter {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  /**
   * Initialize worker (if available).
   *
   * Runtime file is served from /public/workers/indicatorWorker.js
   * and gracefully falls back to main-thread compute if unavailable.
   */
  constructor() {
    if (!canUseWorker()) {
      return;
    }

    try {
      this.worker = new Worker("/workers/indicatorWorker.js");
      this.worker.onmessage = (event) => this.handleWorkerMessage(event as MessageEvent<WorkerResult>);
      this.worker.onerror = () => {
        this.terminate();
      };
    } catch {
      this.worker = null;
    }
  }

  /**
   * Compute indicators (possibly offloaded to worker).
   *
   * PHASE 1 (now): sync compute on main thread
   * PHASE 2 (P2): async compute in worker
   */
  async compute(
    bars: BarData[],
    active: ActiveIndicator[],
  ): Promise<IndicatorSeriesData[]> {
    if (!this.worker) {
      // PHASE 1: sync fallback
      return computeAllIndicators(bars, active);
    }

    // PHASE 2: would be async
    const id = `${Date.now()}-${Math.random()}`;
    const promise = new Promise<IndicatorSeriesData[]>((resolve) => {
      this.pendingRequests.set(id, { resolve, bars, active });
      this.worker!.postMessage({
        type: "compute",
        bars,
        active,
        id,
      } as WorkerMessage);
    });

    return promise;
  }

  private handleWorkerMessage(event: MessageEvent<WorkerResult>): void {
    const { id, result, error } = event.data;
    const pending = this.pendingRequests.get(id);
    if (pending) {
      if (error) {
        console.error(`[IndicatorWorker] ${id}: ${error}; fallback main-thread compute`);
        pending.resolve(computeAllIndicators(pending.bars, pending.active));
      } else {
        pending.resolve(result);
      }
      this.pendingRequests.delete(id);
    }
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }
}

/**
 * Singleton adapter instance.
 *
 * Usage: const result = await workerAdapter.compute(bars, active);
 */
export const indicatorWorkerAdapter = new IndicatorWorkerAdapter();
