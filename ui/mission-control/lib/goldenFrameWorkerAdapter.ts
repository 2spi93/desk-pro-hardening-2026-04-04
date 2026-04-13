import type { LiveChartCandle, LiveChartFrameMeta } from "./chartFrameFeed";

export type GoldenFrameWorkerFrameInput = {
  feedKey: string;
  candles: LiveChartCandle[];
  createdAt: number;
  tradeTsMs: number | null;
  depthTsMs: number | null;
  depthSequence: number | null;
  coalesced: boolean;
  dynamicBufferMs: number;
  adaptiveGraceMs: number;
  backlog: number;
};

export type GoldenFrameWorkerFrameBatchInput = {
  batchKey?: string;
  frames: GoldenFrameWorkerFrameInput[];
};

export type GoldenFrameWorkerTelemetry = {
  sequenceQueueDepth: number;
  syncGapCountDelta: number;
  adaptiveGraceMs: number;
  coalescedFramesDelta: number;
};

export type GoldenFrameWorkerPublishedFrame = {
  feedKey: string;
  candles: LiveChartCandle[];
  meta: LiveChartFrameMeta;
};

export type GoldenFrameWorkerPublishedBatch = {
  batchKey: string;
  publishedAt: number;
  frames: GoldenFrameWorkerPublishedFrame[];
};

type GoldenFrameWorkerRequest =
  | { type: "reset" }
  | { type: "queue-frame"; frame: GoldenFrameWorkerFrameInput }
  | { type: "queue-frame-batch"; batch: GoldenFrameWorkerFrameBatchInput };

export type GoldenFrameWorkerEvent =
  | { type: "state"; telemetry: GoldenFrameWorkerTelemetry }
  | { type: "publish-frame"; telemetry: GoldenFrameWorkerTelemetry; frame: GoldenFrameWorkerPublishedFrame }
  | { type: "publish-frame-batch"; telemetry: GoldenFrameWorkerTelemetry; batch: GoldenFrameWorkerPublishedBatch };

function canUseWorker(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

export class GoldenFrameWorkerAdapter {
  private worker: Worker | null = null;

  constructor(private readonly onEvent: (event: GoldenFrameWorkerEvent) => void) {
    if (!canUseWorker()) {
      return;
    }

    try {
      this.worker = new Worker("/workers/goldenFrameWorker.js");
      this.worker.onmessage = (event) => {
        this.onEvent(event.data as GoldenFrameWorkerEvent);
      };
      this.worker.onerror = () => {
        this.terminate();
      };
    } catch {
      this.worker = null;
    }
  }

  isAvailable(): boolean {
    return this.worker !== null;
  }

  reset(): void {
    this.postMessage({ type: "reset" });
  }

  queueFrame(frame: GoldenFrameWorkerFrameInput): void {
    this.postMessage({ type: "queue-frame", frame });
  }

  queueFrameBatch(batch: GoldenFrameWorkerFrameBatchInput): void {
    this.postMessage({ type: "queue-frame-batch", batch });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private postMessage(message: GoldenFrameWorkerRequest): void {
    this.worker?.postMessage(message);
  }
}