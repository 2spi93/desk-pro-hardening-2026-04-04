export type LatestFrameScheduler<T> = {
  schedule: (payload: T, render: (payload: T) => void) => void;
  cancel: () => void;
  configure: (options: LatestFrameSchedulerOptions) => void;
  getDiagnostics: () => LatestFrameSchedulerDiagnostics;
};

export type LatestFrameSchedulerDiagnostics = {
  scheduledCount: number;
  flushedCount: number;
  overwrittenPendingCount: number;
  minFrameDeferralCount: number;
};

export type LatestFrameSchedulerOptions = {
  minFrameMs?: number;
  strictBucketAlignment?: boolean;
};

export function createLatestFrameScheduler<T>(initialOptions?: LatestFrameSchedulerOptions): LatestFrameScheduler<T> {
  let pending = false;
  let lastPayload: T | null = null;
  let rafId: number | null = null;
  let lastFrameTime = 0;
  let lastRender: ((payload: T) => void) | null = null;
  let options: Required<LatestFrameSchedulerOptions> = {
    minFrameMs: Math.max(8, Math.round(initialOptions?.minFrameMs ?? 16)),
    strictBucketAlignment: initialOptions?.strictBucketAlignment ?? true,
  };
  const diagnostics: LatestFrameSchedulerDiagnostics = {
    scheduledCount: 0,
    flushedCount: 0,
    overwrittenPendingCount: 0,
    minFrameDeferralCount: 0,
  };

  const flush = (frameTime: number) => {
    if (frameTime - lastFrameTime < options.minFrameMs) {
      diagnostics.minFrameDeferralCount += 1;
      rafId = window.requestAnimationFrame(flush);
      return;
    }

    pending = false;
    rafId = null;
    lastFrameTime = options.strictBucketAlignment
      ? frameTime - (frameTime % options.minFrameMs)
      : frameTime;

    const nextPayload = lastPayload;
    const nextRender = lastRender;
    lastPayload = null;

    if (nextPayload !== null && nextRender) {
      diagnostics.flushedCount += 1;
      nextRender(nextPayload);
    }

    if (lastPayload !== null && !pending) {
      pending = true;
      rafId = window.requestAnimationFrame(flush);
    }
  };

  return {
    schedule(payload, render) {
      diagnostics.scheduledCount += 1;
      if (pending && lastPayload !== null) {
        diagnostics.overwrittenPendingCount += 1;
      }
      lastPayload = payload;
      lastRender = render;

      if (pending) {
        return;
      }

      if (typeof window === "undefined") {
        const nextPayload = lastPayload;
        lastPayload = null;
        if (nextPayload !== null) {
          render(nextPayload);
        }
        return;
      }

      pending = true;
      rafId = window.requestAnimationFrame(flush);
    },
    cancel() {
      if (typeof window !== "undefined" && rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      pending = false;
      rafId = null;
      lastPayload = null;
      lastRender = null;
    },
    configure(nextOptions) {
      options = {
        minFrameMs: Math.max(8, Math.round(nextOptions.minFrameMs ?? options.minFrameMs)),
        strictBucketAlignment: nextOptions.strictBucketAlignment ?? options.strictBucketAlignment,
      };
    },
    getDiagnostics() {
      return { ...diagnostics };
    },
  };
}