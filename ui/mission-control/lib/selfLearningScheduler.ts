export type ShadowSchedulerState = "stopped" | "running" | "error";

export type ShadowSchedulerSnapshot = {
  state: ShadowSchedulerState;
  enabled: boolean;
  intervalMs: number;
  runCount: number;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  inFlight: boolean;
};

export class SelfLearningSchedulerController {
  private timer: ReturnType<typeof setInterval> | null = null;

  private snapshot: ShadowSchedulerSnapshot = {
    state: "stopped",
    enabled: false,
    intervalMs: 10 * 60 * 1000,
    runCount: 0,
    lastStartedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    inFlight: false,
  };

  getSnapshot(): ShadowSchedulerSnapshot {
    return { ...this.snapshot };
  }

  start(intervalMs: number, runner: () => Promise<void>, onUpdate?: (snapshot: ShadowSchedulerSnapshot) => void): void {
    this.stop(onUpdate);
    this.snapshot = {
      ...this.snapshot,
      enabled: true,
      state: "running",
      intervalMs,
      lastError: null,
      lastErrorAt: null,
    };
    onUpdate?.(this.getSnapshot());

    const tick = async () => {
      if (this.snapshot.inFlight) {
        return;
      }
      this.snapshot = {
        ...this.snapshot,
        inFlight: true,
        lastStartedAt: new Date().toISOString(),
      };
      onUpdate?.(this.getSnapshot());
      try {
        await runner();
        this.snapshot = {
          ...this.snapshot,
          state: "running",
          runCount: this.snapshot.runCount + 1,
          lastSuccessAt: new Date().toISOString(),
          inFlight: false,
          lastError: null,
          lastErrorAt: null,
        };
      } catch (error) {
        this.snapshot = {
          ...this.snapshot,
          state: "error",
          lastErrorAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : "scheduler_error",
          inFlight: false,
        };
      }
      onUpdate?.(this.getSnapshot());
    };

    this.timer = setInterval(() => {
      void tick();
    }, Math.max(60_000, intervalMs));
  }

  stop(onUpdate?: (snapshot: ShadowSchedulerSnapshot) => void): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.snapshot = {
      ...this.snapshot,
      enabled: false,
      state: "stopped",
      inFlight: false,
    };
    onUpdate?.(this.getSnapshot());
  }

  async triggerNow(runner: () => Promise<void>, onUpdate?: (snapshot: ShadowSchedulerSnapshot) => void): Promise<void> {
    if (this.snapshot.inFlight) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      state: "running",
      inFlight: true,
      lastStartedAt: new Date().toISOString(),
    };
    onUpdate?.(this.getSnapshot());
    try {
      await runner();
      this.snapshot = {
        ...this.snapshot,
        runCount: this.snapshot.runCount + 1,
        lastSuccessAt: new Date().toISOString(),
        inFlight: false,
        lastError: null,
        lastErrorAt: null,
      };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        state: "error",
        inFlight: false,
        lastErrorAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : "scheduler_error",
      };
      onUpdate?.(this.getSnapshot());
      throw error;
    }
    onUpdate?.(this.getSnapshot());
  }
}