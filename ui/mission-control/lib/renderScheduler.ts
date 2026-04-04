export type RenderJobType = "candle" | "indicator" | "dom" | "overlay";

export type RenderJob = {
  type: RenderJobType;
  priority: number;
  callback: () => void;
};

type RenderSchedulerOptions = {
  frameBudgetMs?: number;
};

const DEFAULT_FRAME_BUDGET = 16;
const STAGE_BUDGET_MS: Record<RenderJobType, number> = {
  candle: 6,
  indicator: 4,
  dom: 3,
  overlay: 2,
};

export class RenderScheduler {
  private queue: RenderJob[] = [];
  private running = false;
  private frameBudgetMs: number;

  constructor(options?: RenderSchedulerOptions) {
    this.frameBudgetMs = options?.frameBudgetMs ?? DEFAULT_FRAME_BUDGET;
  }

  enqueue(job: RenderJob): void {
    // Keep only the newest job of each stage to avoid stale work under bursty feeds.
    this.queue = this.queue.filter((queuedJob) => queuedJob.type !== job.type);
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);

    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.flush);
    }
  }

  clear(): void {
    this.queue = [];
    this.running = false;
  }

  private compactBacklog(): void {
    if (this.queue.length <= 4) {
      return;
    }

    const compacted: RenderJob[] = [];
    const seenTypes = new Set<RenderJobType>();

    // Keep only the newest job per stage type when overloaded.
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index];
      if (!seenTypes.has(job.type)) {
        seenTypes.add(job.type);
        compacted.push(job);
      }
    }

    compacted.reverse();
    compacted.sort((a, b) => b.priority - a.priority);
    this.queue = compacted;
  }

  private cumulativeStageBudget(type: RenderJobType): number {
    if (type === "candle") {
      return STAGE_BUDGET_MS.candle;
    }
    if (type === "indicator") {
      return STAGE_BUDGET_MS.candle + STAGE_BUDGET_MS.indicator;
    }
    if (type === "dom") {
      return STAGE_BUDGET_MS.candle + STAGE_BUDGET_MS.indicator + STAGE_BUDGET_MS.dom;
    }
    return STAGE_BUDGET_MS.candle + STAGE_BUDGET_MS.indicator + STAGE_BUDGET_MS.dom + STAGE_BUDGET_MS.overlay;
  }

  private flush = () => {
    const frameStart = performance.now();

    while (this.queue.length > 0) {
      const job = this.queue[0];
      if (!job) {
        break;
      }

      const elapsed = performance.now() - frameStart;
      const stageBudget = this.cumulativeStageBudget(job.type);
      if (elapsed >= stageBudget) {
        if (this.queue.length > 2) {
          this.compactBacklog();
        }
        requestAnimationFrame(this.flush);
        return;
      }

      this.queue.shift();

      job.callback();

      if (performance.now() - frameStart >= this.frameBudgetMs) {
        if (this.queue.length > 2) {
          this.compactBacklog();
        }
        requestAnimationFrame(this.flush);
        return;
      }
    }

    this.running = false;
  };
}
